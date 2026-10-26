/**
 * State logic for the "Subsession models" picker.
 *
 * The picker edits only exact model refs (`provider/model`). A policy can
 * also hold wider selectors (`provider/*`, `provider/model#variant`) set
 * through config or the API: those stay in the list as read-only entries and
 * are preserved verbatim on every save, and `excludedModels` and
 * `agentOverrides` are preserved exactly as loaded.
 */

import type { SubagentPolicy } from "./model"

/** An exact ref names one model with any variant: no wildcard, no `#variant`. */
export function isExactModelRef(selector: string): boolean {
  return !selector.includes("*") && !selector.includes("#")
}

/** The two kinds of `models` entries the picker shows. */
export type SubagentPolicyModels = {
  exact: string[]
  readOnly: string[]
}

export function splitSubagentPolicyModels(policy: SubagentPolicy | undefined): SubagentPolicyModels {
  const exact: string[] = []
  const readOnly: string[] = []
  for (const selector of policy?.models ?? []) {
    if (isExactModelRef(selector)) exact.push(selector)
    else readOnly.push(selector)
  }
  return { exact, readOnly }
}

/**
 * The policy after toggling one exact ref. Read-only entries keep their
 * places, an unchecked ref is removed, a checked ref is appended, and the
 * rest of the policy is carried over unchanged.
 */
export function toggleSubagentModel(
  policy: SubagentPolicy | undefined,
  ref: string,
  checked: boolean,
): SubagentPolicy {
  const current = policy?.models ?? []
  const models = checked
    ? (current.includes(ref) ? [...current] : [...current, ref])
    : current.filter((entry) => entry !== ref)
  return {
    ...policy,
    models,
  }
}

/** The policy a session is created with, or `undefined` when nothing was checked. */
export function subagentPolicyForCreate(selectedRefs: readonly string[]): SubagentPolicy | undefined {
  if (selectedRefs.length === 0) return undefined
  return { models: [...selectedRefs] }
}
