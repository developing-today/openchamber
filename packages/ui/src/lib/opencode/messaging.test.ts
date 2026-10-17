import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Window } from "happy-dom"

import type { SyntheticMessage } from "./model"

const browser = new Window({ url: "http://localhost/" })
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
})

type Handler = (request: Request) => Promise<Response>
let handler: Handler = async (request) => {
  throw new Error(`Unexpected request: ${request.url}`)
}
const requests: Request[] = []
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init)
  requests.push(request)
  return handler(request)
})

const { OpencodeApiError } = await import("./client")
const {
  listMessagingTopics,
  probeMessaging,
  queryMessaging,
  readMessagingNotice,
  sendMessagingMessage,
  setMessagingVar,
} = await import("./messaging")
const { isBackgroundReportEntry, isSkippedTimelineMessage } = await import("@/components/chat/lib/timelineRoles")

const status = {
  state: "ready",
  tier: "default",
  model: "Qwen3-Embedding-0.6B Q8_0",
  tiers: [{ name: "tiny", model: "all-MiniLM-L6-v2 Q8_0", size: "25 MB", hardware: "Runs anywhere", available: true }],
}

const message = () => ({
  id: 1, topic: "ses_a/bidi/ses_b", seq: 1, kind: "message", type: "message", writer: "ses_b", time: 10, data: "hi",
})

beforeEach(() => {
  requests.length = 0
})

afterAll(() => {
  fetchSpy.mockRestore()
  browser.close()
})

describe("probeMessaging", () => {
  test("a server with messaging answers the model status", async () => {
    handler = async () => Response.json({ data: status })
    const probe = await probeMessaging()
    expect(probe).toMatchObject({ kind: "supported", model: { state: "ready", remote: false, progress: [], tiers: [{ name: "tiny" }] } })
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/api/messaging/model")
  })

  test("a 404 or a web page means the routes are missing", async () => {
    handler = async () => new Response("not found", { status: 404 })
    expect(await probeMessaging()).toEqual({ kind: "unsupported" })
    handler = async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })
    expect(await probeMessaging()).toEqual({ kind: "unsupported" })
  })

  test("any other failure throws instead of reading as unsupported", async () => {
    handler = async () => new Response("boom", { status: 500 })
    await expect(probeMessaging()).rejects.toBeInstanceOf(OpencodeApiError)
  })
})

describe("requests", () => {
  test("post the input as JSON and read the data envelope", async () => {
    handler = async () => Response.json({ data: { messages: [message()], more: false, match: "hybrid" } })
    const result = await queryMessaging({ topics: ["ses_a/bidi/ses_b"], markRead: false, hidden: undefined })
    expect(result.messages).toEqual([{ ...message(), hidden: false }])
    const request = requests[0]
    expect(request?.method).toBe("POST")
    expect(new URL(request?.url ?? "").pathname).toBe("/api/messaging/query")
    // Undefined fields are left out so OpenCode applies its defaults.
    expect(await request?.json()).toEqual({ topics: ["ses_a/bidi/ses_b"], markRead: false })
  })

  test("drop one record in a form this build does not read and keep the rest", async () => {
    handler = async () => Response.json({ data: { topics: [{ name: "broken" }, {
      name: "global", exists: true, kind: "global", mode: "open", writers: [], policy: "anyone writes", messages: 2, last: "Infinity",
    }], total: 2 } })
    const result = await listMessagingTopics({})
    expect(result.topics.map((topic) => topic.name)).toEqual(["global"])
    // A non-finite time reads as absent.
    expect(result.topics[0]?.last).toBeUndefined()
  })

  test("keep the HTTP status and OpenCode's message on failure", async () => {
    handler = async () => Response.json({ _tag: "ConflictError", message: "only the owner writes" }, { status: 409 })
    const error = await sendMessagingMessage({ topic: "ses_a/private", text: "x" }).catch((caught) => caught)
    expect(error).toBeInstanceOf(OpencodeApiError)
    expect(error).toMatchObject({ status: 409, tag: "ConflictError", detail: "only the owner writes" })
  })

  test("a failed read never reads as an empty result", async () => {
    handler = async () => Response.json({ data: { unexpected: true } })
    await expect(queryMessaging({})).rejects.toBeInstanceOf(OpencodeApiError)
  })

  test("setting a variable sends PUT and reads no body", async () => {
    handler = async () => new Response(null, { status: 204 })
    await setMessagingVar({ scope: "global", name: "team", value: "search" })
    expect(requests[0]?.method).toBe("PUT")
    expect(await requests[0]?.json()).toEqual({ scope: "global", name: "team", value: "search" })
  })
})

const notice = (overrides: Partial<SyntheticMessage> = {}): SyntheticMessage => ({
  id: "msg_notice",
  sessionID: "ses_a",
  role: "synthetic",
  time: { created: 20 },
  text: '<message topic="ses_a/bidi/ses_b" seq="1" from="ses_b" from_title="Design &quot;API&quot;" type="question" time="x">\nShould we &lt;message> escape?\n</message>',
  description: "✉ Design the API → ses_a/bidi/ses_b: Should we",
  metadata: { source: "messaging", topic: "ses_a/bidi/ses_b", seq: 1, from: "ses_b", type: "question" },
  ...overrides,
})

describe("readMessagingNotice", () => {
  test("reads the sender, topic and the body without its envelope", () => {
    expect(readMessagingNotice(notice())).toEqual({
      topic: "ses_a/bidi/ses_b",
      seq: 1,
      from: "ses_b",
      fromTitle: 'Design "API"',
      type: "question",
      toYou: false,
      agentSees: true,
      body: "Should we <message> escape?",
    })
  })

  test("a message to the person that the agent does not see", () => {
    const read = readMessagingNotice(notice({
      text: '<message to="user" from="ses_b" topic="ses_b/user" seq="2">\nNeed a decision\n</message>',
      metadata: { source: "messaging", audience: "user", topic: "ses_b/user", seq: 2, from: "ses_b", type: "user" },
    }))
    expect(read).toMatchObject({ type: "user", toYou: true, agentSees: false, body: "Need a decision" })
    expect(read?.fromTitle).toBeUndefined()
  })

  test("a writer's own \"user\" label does not make a message one to the person", () => {
    expect(readMessagingNotice(notice({ metadata: { source: "messaging", topic: "builds", seq: 4, from: "ses_b", type: "user" } })))
      .toMatchObject({ type: "user", toYou: false, agentSees: true })
  })

  test("restores a body that quoted the escapes themselves", () => {
    // As OpenCode encodes `<message> &lt;message &amp;lt; R&D`.
    const text = '<message topic="t" seq="2" from="ses_b">\n&lt;message> &amp;lt;message &amp;amp;lt; R&D\n</message>'
    expect(readMessagingNotice(notice({ text }))?.body).toBe("<message> &lt;message &amp;lt; R&D")
  })

  test("ignores other synthetic messages", () => {
    expect(readMessagingNotice(notice({ metadata: undefined }))).toBeUndefined()
    expect(readMessagingNotice(notice({ metadata: { source: "subagent" } }))).toBeUndefined()
  })

  test("renders in the timeline as a report that opens a turn", () => {
    expect(isBackgroundReportEntry(notice())).toBe(true)
    expect(isSkippedTimelineMessage(notice())).toBe(false)
    expect(isSkippedTimelineMessage(notice({ metadata: undefined }))).toBe(true)
  })
})
