import { describe, expect, test } from "bun:test"
import {
  isExactModelRef,
  splitSubagentPolicyModels,
  subagentPolicyForCreate,
  toggleSubagentModel,
} from "./subagentPolicy"
import type { SubagentPolicy } from "./model"

describe("isExactModelRef", () => {
  test("accepts a plain provider/model ref", () => {
    expect(isExactModelRef("anthropic/claude-sonnet-5")).toBe(true)
  })

  test("rejects wildcards and variant refs", () => {
    expect(isExactModelRef("opencode-go/*")).toBe(false)
    expect(isExactModelRef("openai/gpt-5.5#high")).toBe(false)
  })

  test("a route-pool ref is an ordinary exact ref", () => {
    expect(isExactModelRef("opencode-route/team-pool")).toBe(true)
  })
})

describe("splitSubagentPolicyModels", () => {
  test("separates exact refs from read-only selectors, keeping order", () => {
    const policy: SubagentPolicy = {
      models: ["opencode-go/*", "anthropic/claude-sonnet-5", "openai/gpt-5.5#high", "openai/gpt-5.4"],
    }
    expect(splitSubagentPolicyModels(policy)).toEqual({
      exact: ["anthropic/claude-sonnet-5", "openai/gpt-5.4"],
      readOnly: ["opencode-go/*", "openai/gpt-5.5#high"],
    })
  })

  test("an absent policy splits to empty lists", () => {
    expect(splitSubagentPolicyModels(undefined)).toEqual({ exact: [], readOnly: [] })
  })
})

describe("toggleSubagentModel", () => {
  const policy: SubagentPolicy = {
    models: ["opencode-go/*", "anthropic/claude-sonnet-5"],
    excludedModels: ["openai/gpt-5"],
    agentOverrides: { build: { models: ["anthropic/claude-sonnet-5"] } },
  }

  test("checking appends the ref and preserves everything else verbatim", () => {
    expect(toggleSubagentModel(policy, "openai/gpt-5.4", true)).toEqual({
      models: ["opencode-go/*", "anthropic/claude-sonnet-5", "openai/gpt-5.4"],
      excludedModels: ["openai/gpt-5"],
      agentOverrides: { build: { models: ["anthropic/claude-sonnet-5"] } },
    })
  })

  test("unchecking removes only that ref; read-only entries keep their place", () => {
    expect(toggleSubagentModel(policy, "anthropic/claude-sonnet-5", false).models)
      .toEqual(["opencode-go/*"])
  })

  test("checking an already-present ref does not duplicate it", () => {
    expect(toggleSubagentModel(policy, "anthropic/claude-sonnet-5", true).models)
      .toEqual(["opencode-go/*", "anthropic/claude-sonnet-5"])
  })

  test("toggling from no policy starts from an empty list", () => {
    expect(toggleSubagentModel(undefined, "openai/gpt-5.4", true))
      .toEqual({ models: ["openai/gpt-5.4"] })
  })
})

describe("subagentPolicyForCreate", () => {
  test("nothing checked means no policy on create", () => {
    expect(subagentPolicyForCreate([])).toBeUndefined()
  })

  test("checked refs become the create policy", () => {
    expect(subagentPolicyForCreate(["openai/gpt-5.4", "anthropic/claude-sonnet-5"]))
      .toEqual({ models: ["openai/gpt-5.4", "anthropic/claude-sonnet-5"] })
  })

  test("route pools are selectable like any other exact ref", () => {
    expect(subagentPolicyForCreate(["opencode-route/team-pool"]))
      .toEqual({ models: ["opencode-route/team-pool"] })
  })
})
