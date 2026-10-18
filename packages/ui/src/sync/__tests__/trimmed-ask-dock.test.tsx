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
import { setSessionOpener } from "../session-navigation"
import { useSessionUIStore } from "../session-ui-store"
import { createEventRoutingIndex, handleEvent, SyncProvider, useScopedBlockingPermissions, useSubagentRequest } from "../sync-context"
import { getSyncChildStores } from "../sync-refs"

// A directory store trims its oldest sessions when a new one arrives, and
// nothing restores them when a request comes in later. The toast about a
// grandchild's request must still open a session whose dock shows it, even
// though the directory store no longer lists the parent that links the two.

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

// The output lists the dock's requests and whether the grandchild's carries the "From subagent" label there.
const DockProbe: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const permissions = useScopedBlockingPermissions(sessionId, directory)
  const fromSubagent = useSubagentRequest(grandchild.id, sessionId, directory)
  return <output data-from-subagent={fromSubagent}>{permissions.map((permission) => permission.id).join(",")}</output>
}

describe("the dock a toast opens after the request's parent was trimmed", () => {
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
    await act(async () => reactRoot.unmount())
    await win.happyDOM.close()
    restoreGlobals()
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
    setSessionOpener((sessionID, sessionDirectory) => { void useSessionUIStore.getState().setCurrentSession(sessionID, sessionDirectory) })
  })

  afterAll(() => toastSpy.mockRestore())

  test("still docks the grandchild's request", async () => {
    const childStores = getSyncChildStores()
    const store = childStores.getChild(directory)
    if (!store) throw new Error("Expected the directory store")
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
    expect(container.querySelector("output")?.textContent).toBe("per_1")
    expect(container.querySelector("output")?.getAttribute("data-from-subagent")).toBe("true")
  })

  test("shows the request once the global session list brings the missing parent", async () => {
    const store = getSyncChildStores().getChild(directory)
    if (!store) throw new Error("Expected the directory store")
    const request: PermissionRequest = { id: "per_1", sessionID: grandchild.id, action: "bash", resources: ["echo hi"], metadata: {} }
    await render(root.id)
    await act(async () => store.setState({ session: [grandchild, root], permission: { [grandchild.id]: [request] }, form: {} }))
    expect(container.querySelector("output")?.textContent).toBe("")

    await act(async () => useGlobalSessionsStore.getState().applySnapshot([root, child, grandchild], [], "ready"))
    expect(container.querySelector("output")?.textContent).toBe("per_1")
  })
})
