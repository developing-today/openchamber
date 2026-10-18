import { describe, expect, test } from "bun:test"
import type { Session } from "@/lib/opencode/model"

import {
  areRequestArraysReferentiallyEqual,
  blockingRequestLineage,
  collectScopedBlockingRequests,
  isSubagentRequest,
} from "./scoped-blocking-requests"

const session = (id: string, parentID?: string, directory = "/repo"): Session => ({
  id, parentID, directory, projectID: "project", title: id,
  time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const lookupIn = (sessions: Session[]) => (sessionID: string) => sessions.find((item) => item.id === sessionID)

describe("scoped blocking requests", () => {
  test("collects requests for the current session subtree, its own first and nearer subagents before farther ones", () => {
    const rootRequest = { id: "perm_root" }
    const childRequest = { id: "perm_child" }
    const grandchildRequest = { id: "perm_grandchild" }
    const siblingRequest = { id: "perm_sibling" }
    const empty: Array<typeof rootRequest> = []

    const result = collectScopedBlockingRequests(
      {
        ses_grandchild: [grandchildRequest],
        ses_sibling: [siblingRequest],
        ses_child: [childRequest],
        ses_root: [rootRequest],
      },
      "ses_root",
      lookupIn([
        session("ses_root"),
        session("ses_child", "ses_root"),
        session("ses_grandchild", "ses_child"),
        session("ses_sibling"),
      ]),
      empty,
    )

    expect(result).toEqual([rootRequest, childRequest, grandchildRequest])
  })

  test("returns the provided empty array when no scoped requests exist", () => {
    const empty: Array<{ id: string }> = []
    const lookup = lookupIn([session("ses_root")])

    expect(collectScopedBlockingRequests({}, "ses_root", lookup, empty)).toBe(empty)
    expect(collectScopedBlockingRequests({}, null, lookup, empty)).toBe(empty)
  })

  test("compares request arrays by item identity", () => {
    const first = { id: "perm_1" }
    const second = { id: "perm_2" }

    expect(areRequestArraysReferentiallyEqual([first, second], [first, second])).toBe(true)
    expect(areRequestArraysReferentiallyEqual([first, second], [second, first])).toBe(false)
    expect(areRequestArraysReferentiallyEqual([first], [{ id: "perm_1" }])).toBe(false)
  })

  test("attributes requests from subagents at any depth below the viewed session", () => {
    const lookup = lookupIn([
      session("ses_root"),
      session("ses_child", "ses_root"),
      session("ses_grandchild", "ses_child"),
      session("ses_sibling"),
    ])

    expect(isSubagentRequest("ses_child", "ses_root", lookup)).toBe(true)
    expect(isSubagentRequest("ses_grandchild", "ses_root", lookup)).toBe(true)
    expect(isSubagentRequest("ses_grandchild", "ses_child", lookup)).toBe(true)
    expect(isSubagentRequest("ses_root", "ses_root", lookup)).toBe(false)
    expect(isSubagentRequest("ses_root", "ses_child", lookup)).toBe(false)
    expect(isSubagentRequest("ses_sibling", "ses_root", lookup)).toBe(false)
    expect(isSubagentRequest("ses_child", null, lookup)).toBe(false)
  })
})

describe("the lineage of a blocking request", () => {
  test("climbs from the asking session through every ancestor in its directory", () => {
    const lookup = lookupIn([session("root"), session("child", "root"), session("grandchild", "child")])

    expect(blockingRequestLineage("grandchild", lookup)).toEqual(["grandchild", "child", "root"])
  })

  // A moved subagent's requests live in its new directory's store, and the
  // docks above the move read only their own directory's store.
  test("stops before an ancestor in another directory", () => {
    const lookup = lookupIn([session("root"), session("child", "root", "/worktree"), session("grandchild", "child", "/worktree")])

    expect(blockingRequestLineage("grandchild", lookup)).toEqual(["grandchild", "child"])
    expect(collectScopedBlockingRequests({ grandchild: [{ id: "perm" }] }, "root", lookup, [])).toEqual([])
  })

  test("stops at a parent with no record, and is the asking session alone when it has none", () => {
    const lookup = lookupIn([session("child", "missing"), session("grandchild", "child")])

    expect(blockingRequestLineage("grandchild", lookup)).toEqual(["grandchild", "child"])
    expect(blockingRequestLineage("unknown", lookup)).toEqual(["unknown"])
  })

  test("ends on a malformed parent cycle", () => {
    const lookup = lookupIn([session("a", "b"), session("b", "a")])

    expect(blockingRequestLineage("a", lookup)).toEqual(["a", "b"])
  })
})
