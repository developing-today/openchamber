/**
 * How a branch for a worktree is named from the profile settings
 * `worktreeBranchTemplate` and `pullRequestBranchTemplate`. The UI holds the
 * same rules (`packages/ui/src/lib/worktrees/branchNameTemplate.ts`): `{name}`
 * is the worktree's name, and a branch started from a pull request may also
 * use `{pr}`, its number, and `{head}`, its branch.
 */

import { isString } from '../shared/guards.js';

const DEFAULT_WORKTREE_BRANCH_TEMPLATE = '{name}';
export const DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE = '{name}-from-pr-{pr}';

const MAX_TEMPLATE_LENGTH = 120;
// What `git check-ref-format` refuses in a branch name.
const INVALID_BRANCH = /^[-/.]|[/.]$|\.\.|@\{|\/\/|\/\.|\.lock(?:\/|$)|[\s~^:?*[\\]|\p{Cc}/u;

/**
 * @param {string} template
 * @param {{ name: string, pr?: number, head?: string }} values
 */
export const renderBranchName = (template, values) => template
  .replaceAll('{name}', values.name)
  .replaceAll('{pr}', values.pr === undefined ? '' : String(values.pr))
  .replaceAll('{head}', values.head ?? '');

/**
 * A template names the worktree, uses only the variables its kind has, and
 * renders to a name git accepts.
 *
 * @param {unknown} template
 * @param {'worktree' | 'pull-request'} kind
 */
export const isBranchTemplate = (template, kind) => {
  if (!isString(template) || !template.includes('{name}') || template.length > MAX_TEMPLATE_LENGTH) return false;
  if (kind === 'worktree' && /\{(?:pr|head)\}/.test(template)) return false;
  const sample = renderBranchName(template, { name: 'name', pr: 1, head: 'head' });
  return !/[{}]/.test(sample) && !INVALID_BRANCH.test(sample);
};

/**
 * The stored template of a kind, or its default when none or an unusable one is stored.
 *
 * @param {Record<string, unknown> | null | undefined} settings
 * @param {'worktree' | 'pull-request'} kind
 */
export const branchTemplateFrom = (settings, kind) => {
  const stored = kind === 'worktree' ? settings?.worktreeBranchTemplate : settings?.pullRequestBranchTemplate;
  if (isBranchTemplate(stored, kind)) return stored;
  return kind === 'worktree' ? DEFAULT_WORKTREE_BRANCH_TEMPLATE : DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE;
};

/**
 * The first of `name`, `name-2`, `name-3`… that no existing branch has.
 *
 * @param {string} name
 * @param {ReadonlySet<string>} existing
 */
export const uniqueBranchName = (name, existing) => {
  if (!existing.has(name)) return name;
  let suffix = 2;
  while (existing.has(`${name}-${suffix}`)) suffix += 1;
  return `${name}-${suffix}`;
};

/**
 * The branch Settings give a new worktree named `name`: the worktree template
 * filled with it, past any local branch that already has the result.
 *
 * @param {Record<string, unknown> | null | undefined} settings
 * @param {{ all?: string[] } | null | undefined} branches local `getBranches` output
 * @param {string} name the worktree name, or an exact `/path`
 */
export const defaultBranchName = (settings, branches, name) => {
  const local = new Set((branches?.all ?? []).filter((branch) => !branch.startsWith('remotes/')));
  return uniqueBranchName(renderBranchName(branchTemplateFrom(settings, 'worktree'), { name: worktreeNameForBranch(name) }), local);
};

/**
 * The worktree name a template sees: an exact `/path` contributes its last segment.
 *
 * @param {string} worktreeName
 */
export const worktreeNameForBranch = (worktreeName) => (
  worktreeName.startsWith('/') ? worktreeName.split('/').filter(Boolean).pop() ?? worktreeName : worktreeName
);
