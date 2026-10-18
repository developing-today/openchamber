import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { Window } from "happy-dom"
import { OpenCode } from "@opencode/client"
import type { Action } from "sonner"
import { toast } from "@/components/ui"
import type { PermissionRequest, Session } from "@/lib/opencode/model"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getSyncPerformanceDiagnostics, setSyncPerformanceDiagnosticsEnabled } from "../performance-diagnostics"
import { setSessionOpener } from "../session-navigation"
import { useSessionUIStore } from "../session-ui-store"
import { createEventRoutingIndex, handleEvent, SyncProvider, useScopedBlockingPermissions, useSubagentRequest } from "../sync-context"
import { getSyncChildStores } from "../sync-refs"

// A directory store trims its oldest sessions when a new one arrives, and
// nothing restores them when a request comes in later. The dock of the session
// a toast opens must still show a grandchild's request, and must follow every
// place the missing parent's record can come back from.

const directory = "/trimmed-ask"
// OpenCode session ids descend with time, so the store's id order puts the newest first.
const session = (id: string, created: number, parentID?: string): Session => ({
  id, parentID, directory, projectID: "project", title: id,
  time: { created, updated: created }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const root = session("ses_3", 1)
const child = session("ses_2", 2, root.id)
const grandchild = session("ses_1", 3, child.id)
const request: PermissionRequest = { id: "per_1", sessionID: grandchild.id, action: "bash", resources: ["echo hi"], metadata: {} }

// The output lists the dock's requests and whether the grandchild's carries the "From subagent" label there.
const DockProbe: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const permissions = useScopedBlockingPermissions(sessionId, directory)
  const fromSubagent = useSubagentRequest(grandchild.id, sessionId, directory)
  return <output data-from-subagent={fromSubagent}>{permissions.map((permission) => permission.id).join(",")}</output>
}

describe("the dock of a nested subagent's request after its parent was trimmed", () => {
  let win: Window
  let reactRoot: Root
  let container: HTMLElement
  let restoreGlobals: () => void
  const opened: string[] = []
  const shown: Array<{ message: Parameters<typeof toast.info>[0]; options: Parameters<typeof toast.info>[1] }> = []
  // Spy on the real toast object: mock.module would stay registered for every
  // later test file in the process (#46).
  const toastSpy = spyOn(toast, "info").mockImplementation((message, options) => {
    shown.push({ message, options })
    return "toast"
  })
  const sdk = OpenCode.make({ baseUrl: "http://trimmed-ask.test", fetch: () => new Promise<Response>(() => undefined) })
  const render = (sessionId: string | null) => act(async () => reactRoot.render(
    <SyncProvider sdk={sdk} directory={directory}><DockProbe sessionId={sessionId} /></SyncProvider>,
  ))
  const docked = () => container.querySelector("output")?.textContent
  const fromSubagent = () => container.querySelector("output")?.getAttribute("data-from-subagent")
  const directoryStore = () => {
    const store = getSyncChildStores().getChild(directory)
    if (!store) throw new Error("Expected the directory store")
    return store
  }

  beforeEach(async () => {
    win = new Window({ url: "http://localhost" })
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement, localStorage: win.localStorage,
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    }
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
    opened.length = 0
    shown.length = 0
    setSessionOpener((sessionID) => { opened.push(sessionID) })
    container = document.createElement("div")
    document.body.appendChild(container)
    reactRoot = createRoot(container)
    await render(null)
  })

  afterEach(async () => {
    setSyncPerformanceDiagnosticsEnabled(false)
    await act(async () => reactRoot.unmount())
    await win.happyDOM.close()
    restoreGlobals()
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
    setSessionOpener((sessionID, sessionDirectory) => { void useSessionUIStore.getState().setCurrentSession(sessionID, sessionDirectory) })
  })

  afterAll(() => toastSpy.mockRestore())

  test("is the root's, where the toast opens, and shows the request there", async () => {
    const childStores = getSyncChildStores()
    const store = directoryStore()
    const routingIndex = createEventRoutingIndex()
    useGlobalSessionsStore.getState().applySnapshot([root, child, grandchild], [], "ready")
    await act(async () => store.setState({ session: [grandchild, child, root], limit: 2, permission: {}, form: {} }))

    // A newer session pushes the list past its limit before anything is pending.
    await act(async () => handleEvent(directory, { type: "session.created", properties: { info: session("ses_0", 4) } }, childStores, routingIndex, getRuntimeKey()))
    expect(store.getState().session.map((item) => item.id)).not.toContain(child.id)

    await act(async () => handleEvent(directory, {
      type: "permission.asked",
      properties: { id: "per_1", sessionID: grandchild.id, action: "bash", resources: ["echo hi"] },
    }, childStores, routingIndex, getRuntimeKey()))
    // SAFETY: request toasts pass a `{ label, onClick }` action, never a React node.
    const action = shown.find((entry) => entry.message === "Permission needed")?.options?.action as Action | undefined
    if (!action) throw new Error("Expected the permission toast")
    // SAFETY: the request toasts' actions ignore the click event.
    action.onClick({} as Parameters<Action["onClick"]>[0])
    // A tree in one directory still opens its root.
    expect(opened).toEqual([root.id])

    await render(root.id)
    expect(docked()).toBe("per_1")
    expect(fromSubagent()).toBe("true")
  })

  test("shows the request once the global session list brings the missing parent", async () => {
    const store = directoryStore()
    await render(root.id)
    await act(async () => store.setState({ session: [grandchild, root], permission: { [grandchild.id]: [request] }, form: {} }))
    expect(docked()).toBe("")

    await act(async () => useGlobalSessionsStore.getState().applySnapshot([root, child, grandchild], [], "ready"))
    expect(docked()).toBe("per_1")
  })

  // A project's store also lists the sessions of its worktrees, so a resync
  // there, after a reconnect for example, can bring back a parent this store
  // dropped.
  test("shows the request once another directory's store brings the missing parent", async () => {
    const store = directoryStore()
    await render(root.id)
    await act(async () => store.setState({ session: [grandchild, root], permission: { [grandchild.id]: [request] }, form: {} }))
    expect(docked()).toBe("")
    expect(fromSubagent()).toBe("false")

    await act(async () => getSyncChildStores().ensureChild("/trimmed-ask-project", { bootstrap: false }).setState({ session: [child] }))
    expect(docked()).toBe("per_1")
    expect(fromSubagent()).toBe("true")
  })

  test("leaves the cross-directory session index alone while a message streams, and still follows its requests", async () => {
    const store = directoryStore()
    await render(root.id)
    await act(async () => store.setState({ session: [grandchild, child, root], permission: { [grandchild.id]: [request] }, form: {} }))
    expect(docked()).toBe("per_1")

    setSyncPerformanceDiagnosticsEnabled(true)
    // A streamed text delta changes only the message's parts.
    await act(async () => store.setState({
      part: { msg_1: [{ id: "prt_1", sessionID: root.id, messageID: "msg_1", type: "text", text: "Streaming" }] },
    }))
    expect(getSyncPerformanceDiagnostics()?.sessionIndexReads).toBe(0)
    expect(docked()).toBe("per_1")

    // A change to the requests alone still reaches the dock.
    await act(async () => store.setState({ permission: {} }))
    expect(docked()).toBe("")
  })
})
