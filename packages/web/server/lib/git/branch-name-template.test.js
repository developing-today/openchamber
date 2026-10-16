import { describe, expect, it } from 'vitest';

import {
  branchNameFromTemplate,
  branchSafeName,
  branchTemplateFrom,
  defaultBranchName,
  isBranchTemplate,
  renderBranchName,
  uniqueBranchName,
} from './branch-name-template.js';

describe('branch name templates', () => {
  it('fills the name, the pull request number and its branch, taking values literally', () => {
    expect(renderBranchName('{name}-from-pr-{pr}', { name: 'csv-export', pr: 42, head: 'fix' })).toBe('csv-export-from-pr-42');
    expect(renderBranchName('dp/{head}/{name}', { name: 'csv', pr: 42, head: 'fix' })).toBe('dp/fix/csv');
    expect(renderBranchName('{name}-x', { name: 'a$&b' })).toBe('a$&b-x');
  });

  it('accepts only templates that name the worktree, use their kind\'s variables and render to a usable branch', () => {
    expect(isBranchTemplate('dp/{name}', 'worktree')).toBe(true);
    expect(isBranchTemplate('{name}-from-pr-{pr}', 'pull-request')).toBe(true);
    expect(isBranchTemplate('static', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name}-{pr}', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name} {date}', 'worktree')).toBe(false);
    expect(isBranchTemplate('{name}..x', 'worktree')).toBe(false);
    expect(isBranchTemplate('-{name}', 'worktree')).toBe(false);
    expect(isBranchTemplate('heads/{name}', 'worktree')).toBe(false);
    expect(isBranchTemplate(42, 'worktree')).toBe(false);
  });

  it('falls back to the default for a missing or unusable stored template', () => {
    expect(branchTemplateFrom({}, 'worktree')).toBe('{name}');
    expect(branchTemplateFrom({ pullRequestBranchTemplate: 'nope' }, 'pull-request')).toBe('{name}-from-pr-{pr}');
    expect(branchTemplateFrom({ worktreeBranchTemplate: 'dp/{name}' }, 'worktree')).toBe('dp/{name}');
  });

  it('makes a typed name or a path fit for a branch and keeps its folders', () => {
    expect(branchSafeName('Fix login timeout')).toBe('Fix-login-timeout');
    expect(branchSafeName('/work/My Exact Tree/')).toBe('My-Exact-Tree');
    expect(branchSafeName('feat/login')).toBe('feat/login');
    expect(branchSafeName('a..b:c?d.lock')).toBe('a.b-c-d-lock');
    expect(branchNameFromTemplate('dp/{name}', { name: '---' })).toBe('dp/worktree');
  });

  it('steps past a branch with the name or one that uses it as a folder', () => {
    expect(uniqueBranchName('csv', new Set(['csv', 'csv-2']))).toBe('csv-3');
    expect(uniqueBranchName('csv', new Set(['csv/old']))).toBe('csv-2');
    expect(uniqueBranchName('csv', new Set(['other']))).toBe('csv');
    expect(defaultBranchName({ worktreeBranchTemplate: 'dp/{name}' }, { all: ['dp/fix-login', 'remotes/origin/dp/x'] }, 'Fix login'))
      .toBe('dp/Fix-login');
  });
});
