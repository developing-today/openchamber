import { describe, expect, test } from 'bun:test';

import { branchNameFromTemplate, branchSafeName, isBranchTemplate, renderBranchName, uniqueBranchName } from './branchNameTemplate';

describe('branch name templates', () => {
  test('fill the name, the pull request number and its branch, taking values literally', () => {
    expect(renderBranchName('{name}-from-pr-{pr}', { name: 'csv-export', pr: 42, head: 'fix' })).toBe('csv-export-from-pr-42');
    expect(renderBranchName('dp/{head}/{name}', { name: 'csv', pr: 42, head: 'fix' })).toBe('dp/fix/csv');
    expect(renderBranchName('{name}-x', { name: 'a$&b' })).toBe('a$&b-x');
  });

  test('must name the worktree, use their kind\'s variables and render to a usable branch', () => {
    expect(isBranchTemplate('dp/{name}', 'worktree')).toBe(true);
    expect(isBranchTemplate('{name}-from-pr-{pr}', 'pull-request')).toBe(true);
    expect(isBranchTemplate('static', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name}-{pr}', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name}-{date}', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name} x', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name}.lock', 'worktree')).toBe(false);
    expect(isBranchTemplate('refs/{name}', 'worktree')).toBe(false);
  });

  test('make a typed name or a path fit for a branch and keep its folders', () => {
    expect(branchSafeName('Fix login timeout')).toBe('Fix-login-timeout');
    expect(branchSafeName('/work/My Exact Tree')).toBe('My-Exact-Tree');
    expect(branchSafeName('feat/login')).toBe('feat/login');
    expect(branchNameFromTemplate('{name}-from-pr-{pr}', { name: 'csv export', pr: 42 })).toBe('csv-export-from-pr-42');
  });

  test('step past a branch with the name or one that uses it as a folder', () => {
    expect(uniqueBranchName('csv', new Set(['csv', 'csv-2']))).toBe('csv-3');
    expect(uniqueBranchName('csv', new Set(['csv/old']))).toBe('csv-2');
    expect(uniqueBranchName('csv', new Set(['other']))).toBe('csv');
  });
});
