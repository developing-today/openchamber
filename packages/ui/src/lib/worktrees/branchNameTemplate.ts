/**
 * How OpenChamber names a branch it makes for a worktree: a Settings template
 * over the worktree's name. `{name}` is that name (typed, generated from the
 * prompt, or random). A branch started from a pull request has its own
 * template, which may also use `{pr}`, the request's number, and `{head}`,
 * its branch. A branch the user types in the New worktree dialog is theirs
 * and is never templated.
 *
 * The server holds the same rules for worktrees agents create
 * (`packages/web/server/lib/git/branch-name-template.js`).
 */

export const DEFAULT_WORKTREE_BRANCH_TEMPLATE = '{name}';
export const DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE = '{name}-from-pr-{pr}';

const MAX_TEMPLATE_LENGTH = 120;
// What `git check-ref-format` refuses in a branch name.
const INVALID_BRANCH = /^[-/.]|[/.]$|\.\.|@\{|\/\/|\/\.|\.lock(?:\/|$)|[\s~^:?*[\\]|\p{Cc}/u;

export type BranchTemplateKind = 'worktree' | 'pull-request';

/**
 * Fills a template; `{pr}` and `{head}` only mean something for a pull request.
 * Replacers are functions, so a `$&` in a value stays as written.
 */
export const renderBranchName = (template: string, values: { name: string; pr?: number; head?: string }): string => template
  .replaceAll('{name}', () => values.name)
  .replaceAll('{pr}', () => (values.pr === undefined ? '' : String(values.pr)))
  .replaceAll('{head}', () => values.head ?? '');

/**
 * A worktree name made fit for a branch: an exact `/path` contributes its last
 * segment, and each `/`-separated part keeps letters, digits and `._-`, so a
 * typed "Fix login timeout" becomes `Fix-login-timeout` and `feat/login` stays.
 */
export const branchSafeName = (worktreeName: string): string => {
  const name = worktreeName.startsWith('/') ? worktreeName.split('/').filter(Boolean).pop() ?? '' : worktreeName;
  return name
    .split('/')
    .map((part) => part
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/-{2,}/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .replace(/\.lock$/i, '-lock'))
    .filter(Boolean)
    .join('/');
};

/** The branch a template gives a worktree name, before any suffix. */
export const branchNameFromTemplate = (template: string, values: { name: string; pr?: number; head?: string }): string => (
  renderBranchName(template, { ...values, name: branchSafeName(values.name) || 'worktree' })
);

/**
 * A template names the worktree, so two worktrees never share a branch, uses
 * only the variables its kind has, and renders to a name git accepts.
 */
export const isBranchTemplate = (template: string, kind: BranchTemplateKind): boolean => {
  if (!template.includes('{name}') || template.length > MAX_TEMPLATE_LENGTH) return false;
  if (kind === 'worktree' && /\{(?:pr|head)\}/.test(template)) return false;
  const sample = renderBranchName(template, { name: 'name', pr: 1, head: 'head' });
  // A prefix git's ref plumbing strips would never reach the branch.
  if (/^(?:refs|heads|remotes)\//.test(sample)) return false;
  return !/[{}]/.test(sample) && !INVALID_BRANCH.test(sample);
};

/**
 * The first of `name`, `name-2`, `name-3`… that no existing branch has, and
 * that no existing branch uses as a folder (`name/…` would block `name`).
 */
export const uniqueBranchName = (name: string, existing: ReadonlySet<string>): string => {
  const taken = (candidate: string) => existing.has(candidate)
    || [...existing].some((branch) => branch.startsWith(`${candidate}/`));
  if (!taken(name)) return name;
  let suffix = 2;
  while (taken(`${name}-${suffix}`)) suffix += 1;
  return `${name}-${suffix}`;
};
