import { describe, expect, test } from 'bun:test';

import { isBranchTemplate, renderBranchName, uniqueBranchName } from './branchNameTemplate';

describe('branch name templates', () => {
  test('fill the name, the pull request number and its branch', () => {
    expect(renderBranchName('{name}-from-pr-{pr}', { name: 'csv-export', pr: 42, head: 'fix' })).toBe('csv-export-from-pr-42');
    expect(renderBranchName('dp/{head}/{name}', { name: 'csv', pr: 42, head: 'fix' })).toBe('dp/fix/csv');
  });

  test('must name the worktree, use their kind\'s variables and render to a branch git accepts', () => {
    expect(isBranchTemplate('dp/{name}', 'worktree')).toBe(true);
    expect(isBranchTemplate('{name}-from-pr-{pr}', 'pull-request')).toBe(true);
    expect(isBranchTemplate('static', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name}-{pr}', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name}-{date}', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name} x', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name}.lock', 'worktree')).toBe(false);
  });

  test('step past names a branch already has', () => {
    expect(uniqueBranchName('csv', new Set(['csv', 'csv-2']))).toBe('csv-3');
    expect(uniqueBranchName('csv', new Set(['other']))).toBe('csv');
  });
});
