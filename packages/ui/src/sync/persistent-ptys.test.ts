import { beforeEach, describe, expect, test } from "bun:test"
import type { PersistentPtyInfo } from "@opencode/client"
import type { SyncEvent } from "@/lib/opencode/events"
import { applyPersistentPtyEvents, replaceSessionTerminals, usePersistentPtysStore } from "./persistent-ptys"

const terminal = (id: string, sessionID: string): PersistentPtyInfo => ({
  id,
  title: `title ${id}`,
  command: "bash",
  args: [],
  cwd: "/repo",
  status: "running",
  pid: 1,
  sessionID,
  foregroundProcess: null,
  size: { cols: 120, rows: 40 },
  output: { head: 0, tail: 0 },
})

const added = (sessionID: string, id: string): SyncEvent => ({
  type: "persistent-pty.added",
  properties: { sessionID, terminal: terminal(id, sessionID) },
})

const removed = (sessionID: string, ptyID: string): SyncEvent => ({
  type: "persistent-pty.removed",
  properties: { sessionID, ptyID },
})

const ids = (): string[] => [...usePersistentPtysStore.getState().byId.keys()].sort()

describe("persistent PTY index", () => {
  beforeEach(() => {
    usePersistentPtysStore.setState({ byId: new Map() })
  })

  test("added terminals carry the directory they were announced in, removed ones leave", () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1"), added("ses_a", "pty_2")])
    expect(ids()).toEqual(["pty_1", "pty_2"])
    expect(usePersistentPtysStore.getState().byId.get("pty_1")?.directory).toBe("/repo")

    applyPersistentPtyEvents("/repo", [removed("ses_a", "pty_1")])
    expect(ids()).toEqual(["pty_2"])
  })

  test("a session's list read replaces only that session's terminals", () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_old"), added("ses_b", "pty_b")])

    replaceSessionTerminals("ses_a", "/repo", [terminal("pty_new", "ses_a")])

    expect(ids()).toEqual(["pty_b", "pty_new"])
  })

  test("events that are not terminal events leave the index untouched", () => {
    applyPersistentPtyEvents("/repo", [added("ses_a", "pty_1")])
    const before = usePersistentPtysStore.getState().byId

    applyPersistentPtyEvents("/repo", [{ type: "vcs.branch.updated", properties: {} }])

    expect(usePersistentPtysStore.getState().byId).toBe(before)
  })
})
