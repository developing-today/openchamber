import { describe, expect, test } from "bun:test"
import type { FormRequest, Session } from "@/lib/opencode/model"

import { collectComposerForms } from "./sync-context"
import { LOCATION_SCOPED_FORM_SESSION_ID } from "./location-scoped-forms"

const session = (id: string, parentID?: string): Session => ({
  id, parentID, directory: "/repo", projectID: "project", title: id,
  time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})
const form = (id: string, sessionID: string): FormRequest => ({ id, sessionID, title: id, fields: [{ key: "answer", type: "boolean" }] })

describe("composer forms", () => {
  const empty: FormRequest[] = []
  const own = form("form_own", "ses_root")
  const child = form("form_child", "ses_child")
  const elicitation = form("form_mcp", LOCATION_SCOPED_FORM_SESSION_ID)
  const sessions = [session("ses_root"), session("ses_child", "ses_root"), session("ses_other")]
  const lookup = (sessionID: string) => sessions.find((item) => item.id === sessionID)

  test("a location-scoped form follows the session subtree's own forms", () => {
    const result = collectComposerForms(
      { ses_root: [own], ses_child: [child], [LOCATION_SCOPED_FORM_SESSION_ID]: [elicitation] },
      "ses_root",
      lookup,
      empty,
    )
    expect(result).toEqual([own, child, elicitation])
  })

  test("a location-scoped form reaches a session with no forms of its own", () => {
    const result = collectComposerForms({ [LOCATION_SCOPED_FORM_SESSION_ID]: [elicitation] }, "ses_other", lookup, empty)
    expect(result).toEqual([elicitation])
  })

  test("without a session there is nothing to show it from", () => {
    expect(collectComposerForms({ [LOCATION_SCOPED_FORM_SESSION_ID]: [elicitation] }, null, lookup, empty)).toBe(empty)
  })

  test("the shared empty list survives when neither kind is pending", () => {
    expect(collectComposerForms({ [LOCATION_SCOPED_FORM_SESSION_ID]: [] }, "ses_root", lookup, empty)).toBe(empty)
  })
})
