import { afterEach, describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { resolveBlockingRequestRoot } from "./blocking-request-root"

const session = (id: string, parentID?: string, directory = "/repo"): Session => ({
  id, parentID, directory, projectID: "project", title: id,
  time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

const known = (...sessions: Session[]) => useGlobalSessionsStore.getState().applySnapshot(sessions, [], "ready")

describe("the session a blocking request is answered from", () => {
  afterEach(() => useGlobalSessionsStore.getState().resetForRuntimeSwitch())

  test("is the top-level session above a request raised at any depth in one directory", () => {
    known(session("root"), session("child", "root"), session("grandchild", "child"), session("great", "grandchild"))

    expect(resolveBlockingRequestRoot("great")).toEqual({ sessionID: "root", directory: "/repo" })
    expect(resolveBlockingRequestRoot("root")).toEqual({ sessionID: "root", directory: "/repo" })
  })

  // A moved subagent's requests live in its new directory's store, and an
  // ancestor's dock reads only its own directory's store.
  test("stays in the directory of a subagent that moved, below the ancestors it left", () => {
    known(session("root"), session("child", "root", "/worktree"), session("grandchild", "child", "/worktree"))

    expect(resolveBlockingRequestRoot("grandchild")).toEqual({ sessionID: "child", directory: "/worktree" })
  })

  test("stops below an intermediate subagent that moved to another directory", () => {
    known(session("root"), session("child", "root", "/elsewhere"), session("grandchild", "child"))

    expect(resolveBlockingRequestRoot("grandchild")).toEqual({ sessionID: "grandchild", directory: "/repo" })
  })

  test("stops at the highest session this client knows", () => {
    known(session("child", "missing-root"), session("grandchild", "child"))

    expect(resolveBlockingRequestRoot("grandchild")).toEqual({ sessionID: "child", directory: "/repo" })
  })

  test("is the asking session itself, without a directory, when no record of it is held", () => {
    expect(resolveBlockingRequestRoot("unknown")).toEqual({ sessionID: "unknown", directory: null })
  })

  test("ends on a malformed parent cycle", () => {
    known(session("a", "b"), session("b", "a"))

    expect(resolveBlockingRequestRoot("a")).toEqual({ sessionID: "b", directory: "/repo" })
  })
})
