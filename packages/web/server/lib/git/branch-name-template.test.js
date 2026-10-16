import { describe, expect, it } from 'vitest';

import { branchTemplateFrom, isBranchTemplate, renderBranchName, uniqueBranchName, worktreeNameForBranch } from './branch-name-template.js';

describe('branch name templates', () => {
  it('fills the name, the pull request number and its branch', () => {
    expect(renderBranchName('{name}-from-pr-{pr}', { name: 'csv-export', pr: 42, head: 'fix' })).toBe('csv-export-from-pr-42');
    expect(renderBranchName('dp/{head}/{name}', { name: 'csv', pr: 42, head: 'fix' })).toBe('dp/fix/csv');
  });

  it('accepts only templates that name the worktree, use their kind\'s variables and render to a valid branch', () => {
    expect(isBranchTemplate('dp/{name}', 'worktree')).toBe(true);
    expect(isBranchTemplate('{name}-from-pr-{pr}', 'pull-request')).toBe(true);
    expect(isBranchTemplate('static', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name}-{pr}', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name} {date}', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name}..x', 'worktree')).toBe(false);
    expect(isBranchTemplate('-{name}', 'worktree')).toBe(false);
    expect(isBranchTemplate(42, 'worktree')).toBe(false);
  });

  it('falls back to the default for a missing or unusable stored template', () => {
    expect(branchTemplateFrom({}, 'worktree')).toBe('{name}');
    expect(branchTemplateFrom({ pullRequestBranchTemplate: 'nope' }, 'pull-request')).toBe('{name}-from-pr-{pr}');
    expect(branchTemplateFrom({ worktreeBranchTemplate: 'dp/{name}' }, 'worktree')).toBe('dp/{name}');
  });

  it('suffixes a name a branch already has, and takes a path\'s last segment', () => {
    expect(uniqueBranchName('csv', new Set(['csv', 'csv-2']))).toBe('csv-3');
    expect(uniqueBranchName('csv', new Set())).toBe('csv');
    expect(worktreeNameForBranch('/work/review-42/')).toBe('review-42');
    expect(worktreeNameForBranch('review-42')).toBe('review-42');
  });
});
