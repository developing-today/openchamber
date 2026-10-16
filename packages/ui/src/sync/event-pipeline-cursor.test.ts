import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { adoptRelayTunnel, deactivateRelayTunnel } from "@/lib/relay/runtime-tunnel"
import type { RelayTunnelClient, RelayTunnelWebSocket } from "@/lib/relay/tunnel-client"
import { clearRuntimeUrlAuthToken, setRuntimeUrlAuthToken } from "@/lib/runtime-auth"
import { createEventPipeline } from "./event-pipeline"

const wireDelta = (id: string, directory: string, delta: string) => ({
  id,
  created: 1000,
  location: { directory },
  type: "session.text.delta",
  data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta },
})

/**
 * The WebSocket transport never reads the SDK, so this is a real client whose
 * requests reject: a stray call fails the test instead of reaching the network.
 */
const unusedSdk: OpenCodeClient = OpenCode.make({
  baseUrl: "http://runtime.test",
  fetch: () => Promise.reject(new Error("the WebSocket transport must not fetch")),
})

/** A relay tunnel socket the test drives by hand. */
function createFakeSocket(): RelayTunnelWebSocket {
  let readyState = 1
  return {
    get readyState() { return readyState },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: () => undefined,
    close: () => { readyState = 3 },
  }
}

function adoptTunnel() {
  const opened: Array<{ path: string; socket: RelayTunnelWebSocket }> = []
  const tunnel: RelayTunnelClient = {
    async fetch() { throw new Error("the WebSocket transport must not fetch") },
    openWebSocket(pathWithQuery) {
      const socket = createFakeSocket()
      opened.push({ path: pathWithQuery, socket })
      return socket
    },
    getStatus: () => ({ state: "connected" }),
    subscribeStatus: () => () => undefined,
    retry: () => undefined,
    close: () => undefined,
  }
  adoptRelayTunnel({ relayUrl: "wss://relay.test", serverId: "fixture", hostEncPubJwk: {} }, tunnel)
  return opened
}

/** The `lastEventId` a socket was opened with, or null when it was opened without one. */
const cursorOf = (path: string): string | null => new URL(path, "http://runtime.test").searchParams.get("lastEventId")

async function waitFor(condition: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const frame = (input: { eventId: string; event: unknown }) => ({
  data: JSON.stringify({ type: "event", eventId: input.eventId, directory: "/repo", payload: input.event }),
})

describe("createEventPipeline resume cursor over the WebSocket transport", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: Object.assign(new EventTarget(), { location: new URL("http://runtime.test") }),
      configurable: true,
      writable: true,
    })
    setRuntimeUrlAuthToken("fixture-url-token", Date.now() + 10 * 60_000)
  })

  afterEach(() => {
    deactivateRelayTunnel()
    clearRuntimeUrlAuthToken()
    Reflect.deleteProperty(globalThis, "window")
  })

  test("moves the cursor only once a frame's event is applied, and then past every applied frame", async () => {
    const opened = adoptTunnel()
    const delivered: string[] = []
    const pipeline = createEventPipeline({
      sdk: unusedSdk,
      onEvents: (_directory, batch) => { delivered.push(...batch.map((event) => event.type)) },
      transport: "ws",
      heartbeatTimeoutMs: 60_000,
      reconnectDelayMs: 60_000,
    })
    try {
      await waitFor(() => opened.length === 1)
      const first = opened[0].socket
      first.onmessage?.({ data: JSON.stringify({ type: "ready" }) })
      first.onmessage?.(frame({ eventId: "inst:1", event: wireDelta("evt_1", "/repo", "a") }))

      // Received but not yet applied: a reconnect now must not skip it.
      pipeline.reconnect("probe")
      await waitFor(() => opened.length === 2)
      expect(cursorOf(opened[1].path)).toBeNull()

      // Applied once its batch is delivered: the next reconnect resumes after it.
      await waitFor(() => delivered.length === 1)
      pipeline.reconnect("probe")
      await waitFor(() => opened.length === 3)
      expect(cursorOf(opened[2].path)).toBe("inst:1")
    } finally {
      pipeline.cleanup()
    }
  })

  test("does not move the cursor past an event still queued for another directory", async () => {
    const opened = adoptTunnel()
    const delivered: string[] = []
    const pipeline = createEventPipeline({
      sdk: unusedSdk,
      onEvents: (_directory, batch) => { delivered.push(...batch.map((event) => event.type)) },
      transport: "ws",
      heartbeatTimeoutMs: 60_000,
      reconnectDelayMs: 60_000,
    })
    try {
      await waitFor(() => opened.length === 1)
      const socket = opened[0].socket
      socket.onmessage?.({ data: JSON.stringify({ type: "ready" }) })
      socket.onmessage?.({ data: JSON.stringify({ type: "event", eventId: "inst:1", directory: "/repo", payload: wireDelta("evt_1", "/repo", "a") }) })
      socket.onmessage?.({ data: JSON.stringify({ type: "event", eventId: "inst:2", directory: "/other", payload: wireDelta("evt_2", "/other", "b") }) })

      await waitFor(() => delivered.length === 2)
      pipeline.reconnect("probe")
      await waitFor(() => opened.length === 2)
      expect(cursorOf(opened[1].path)).toBe("inst:2")
    } finally {
      pipeline.cleanup()
    }
  })

  test("adopts the server's head as its cursor when it has none, so an idle client resumes from it", async () => {
    const opened = adoptTunnel()
    const reconnects: Array<{ replayReset: boolean; resumed: boolean }> = []
    const pipeline = createEventPipeline({
      sdk: unusedSdk,
      onEvents: () => undefined,
      onReconnect: (details) => { reconnects.push(details) },
      transport: "ws",
      heartbeatTimeoutMs: 60_000,
      reconnectDelayMs: 60_000,
    })
    try {
      await waitFor(() => opened.length === 1)
      opened[0].socket.onmessage?.({ data: JSON.stringify({ type: "ready", headEventId: "inst:5" }) })
      await waitFor(() => reconnects.length === 1)

      // No event was applied, yet the reconnect resumes from the head the server named.
      pipeline.reconnect("probe")
      await waitFor(() => opened.length === 2)
      expect(cursorOf(opened[1].path)).toBe("inst:5")
    } finally {
      pipeline.cleanup()
    }
  })

  test("takes no cursor from a ready frame without a head, and keeps its own cursor over a later head", async () => {
    const opened = adoptTunnel()
    const delivered: string[] = []
    const reconnects: Array<{ replayReset: boolean; resumed: boolean }> = []
    const pipeline = createEventPipeline({
      sdk: unusedSdk,
      onEvents: (_directory, batch) => { delivered.push(...batch.map((event) => event.type)) },
      onReconnect: (details) => { reconnects.push(details) },
      transport: "ws",
      heartbeatTimeoutMs: 60_000,
      reconnectDelayMs: 60_000,
    })
    try {
      // The hub has seen no OpenCode event: no head, so this reconnect carries no cursor and refetches.
      await waitFor(() => opened.length === 1)
      opened[0].socket.onmessage?.({ data: JSON.stringify({ type: "ready" }) })
      await waitFor(() => reconnects.length === 1)
      pipeline.reconnect("probe")
      await waitFor(() => opened.length === 2)
      expect(cursorOf(opened[1].path)).toBeNull()

      // The next connection is named a head, which it adopts; then an applied event moves the cursor past it.
      const second = opened[1].socket
      second.onmessage?.({ data: JSON.stringify({ type: "ready", headEventId: "inst:5" }) })
      second.onmessage?.(frame({ eventId: "inst:6", event: wireDelta("evt_6", "/repo", "a") }))
      await waitFor(() => delivered.length === 1)
      pipeline.reconnect("probe")
      await waitFor(() => opened.length === 3)
      expect(cursorOf(opened[2].path)).toBe("inst:6")

      // A later head does not move a cursor the client already has.
      opened[2].socket.onmessage?.({ data: JSON.stringify({ type: "ready", resumed: true, headEventId: "inst:9" }) })
      await waitFor(() => reconnects.length === 3)
      pipeline.reconnect("probe")
      await waitFor(() => opened.length === 4)
      expect(cursorOf(opened[3].path)).toBe("inst:6")
    } finally {
      pipeline.cleanup()
    }
  })

  test("reports a resumed ready as resumed, and a replay reset clears the cursor", async () => {
    const opened = adoptTunnel()
    const reconnects: Array<{ replayReset: boolean; resumed: boolean }> = []
    const pipeline = createEventPipeline({
      sdk: unusedSdk,
      onEvents: () => undefined,
      onReconnect: (details) => { reconnects.push(details) },
      transport: "ws",
      heartbeatTimeoutMs: 60_000,
      reconnectDelayMs: 60_000,
    })
    try {
      await waitFor(() => opened.length === 1)
      const first = opened[0].socket
      first.onmessage?.({ data: JSON.stringify({ type: "ready" }) })
      first.onmessage?.(frame({ eventId: "inst:1", event: wireDelta("evt_1", "/repo", "a") }))
      await waitFor(() => reconnects.length === 1)
      expect(reconnects[0]).toEqual({ replayReset: false, resumed: false })

      pipeline.reconnect("probe")
      await waitFor(() => opened.length === 2)
      const second = opened[1].socket
      second.onmessage?.({ data: JSON.stringify({ type: "ready", resumed: true }) })
      await waitFor(() => reconnects.length === 2)
      expect(reconnects[1]).toEqual({ replayReset: false, resumed: true })
      await new Promise((resolve) => setTimeout(resolve, 150))

      pipeline.reconnect("probe")
      await waitFor(() => opened.length === 3)
      expect(cursorOf(opened[2].path)).toBe("inst:1")

      const third = opened[2].socket
      third.onmessage?.({ data: JSON.stringify({ type: "ready", replayReset: true }) })
      await waitFor(() => reconnects.length === 3)
      expect(reconnects[2]).toEqual({ replayReset: true, resumed: false })
      pipeline.reconnect("probe")
      await waitFor(() => opened.length === 4)
      expect(cursorOf(opened[3].path)).toBeNull()
    } finally {
      pipeline.cleanup()
    }
  })
})
