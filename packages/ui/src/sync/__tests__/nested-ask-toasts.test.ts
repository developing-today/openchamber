import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import type { Action } from "sonner"
import { toast } from "@/components/ui"
import type { SyncEvent } from "@/lib/opencode/events"
import type { Session } from "@/lib/opencode/model"
import { createRuntimeOpencodeClient } from "@/lib/opencode/client"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { ChildStoreManager } from "../child-store"
import { setSessionOpener } from "../session-navigation"
import { useSessionUIStore } from "../session-ui-store"
import { createEventRoutingIndex, handleEvent } from "../sync-context"
import { setSyncRefs } from "../sync-refs"

// A permission request or form raised by a subagent at any depth is docked in
// the composer of the highest session above it in the same directory, the
// top-level one here, so its toast opens that one.

const session = (id: string, parentID?: string): Session => ({
  id, parentID, directory: "/repo", projectID: "project", title: id,
  time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

const lineage = [session("ses_root"), session("ses_child", "ses_root"), session("ses_grandchild", "ses_child")]

describe("toasts for a nested subagent's requests", () => {
  let childStores: ChildStoreManager
  const opened: Array<[string, string]> = []
  const shown: Array<{ message: Parameters<typeof toast.info>[0]; options: Parameters<typeof toast.info>[1] }> = []
  // Spy on the real toast object: mock.module would stay registered for every
  // later test file in the process (#46).
  const toastSpy = spyOn(toast, "info").mockImplementation((message, options) => {
    shown.push({ message, options })
    return "toast"
  })
  const clickToastAction = (title: string) => {
    // SAFETY: request toasts pass a `{ label, onClick }` action, never a React node.
    const action = shown.find((entry) => entry.message === title)?.options?.action as Action | undefined
    if (!action) throw new Error(`Expected a toast "${title}" with an action`)
    // SAFETY: the request toasts' actions ignore the click event.
    action.onClick({} as Parameters<Action["onClick"]>[0])
  }

  beforeEach(() => {
    childStores = new ChildStoreManager()
    setSyncRefs(createRuntimeOpencodeClient({ baseUrl: "http://localhost" }), childStores, "/repo")
    opened.length = 0
    shown.length = 0
    setSessionOpener((sessionID, directory) => { opened.push([sessionID, directory]) })
  })

  afterEach(() => {
    childStores.disposeAll()
    useGlobalSessionsStore.getState().resetForRuntimeSwitch()
    setSessionOpener((sessionID, directory) => { void useSessionUIStore.getState().setCurrentSession(sessionID, directory) })
  })

  afterAll(() => toastSpy.mockRestore())

  test("a grandchild's permission opens the root from the directory store's lineage", () => {
    const store = childStores.ensureChild("/repo", { bootstrap: false })
    store.setState({ session: lineage })
    const asked: SyncEvent = {
      type: "permission.asked",
      properties: { id: "per_1", sessionID: "ses_grandchild", action: "bash", resources: ["echo hi"] },
    }

    handleEvent("/repo", asked, childStores, createEventRoutingIndex(), getRuntimeKey())
    clickToastAction("Permission needed")

    expect(opened).toEqual([["ses_root", "/repo"]])
  })

  test("a grandchild's form in a directory without a store opens the root from the global list", () => {
    useGlobalSessionsStore.getState().applySnapshot(lineage, [], "ready")
    const created: SyncEvent = {
      type: "form.created",
      properties: { form: { id: "frm_1", sessionID: "ses_grandchild", title: "Pick a layout", fields: [{ key: "answer", type: "boolean" }] } },
    }

    handleEvent("/repo", created, childStores, createEventRoutingIndex(), getRuntimeKey())
    clickToastAction("Pick a layout")

    expect(opened).toEqual([["ses_root", "/repo"]])
  })
})
