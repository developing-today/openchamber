import { describe, expect, test } from 'bun:test';

import {
  checkPullRequestSource,
  formatStartRefLabel,
  groupStartSourceBranches,
  resolveRemoteDefaultStartRef,
  selectWorktreeStartFrom,
} from './worktreeStartSource';

describe('resolveRemoteDefaultStartRef', () => {
  test('takes the branch origin\'s HEAD points at, before any other remote', () => {
    expect(resolveRemoteDefaultStartRef({
      all: ['main', 'remotes/upstream/main', 'remotes/origin/trunk'],
      defaultBranches: { upstream: 'main', origin: 'trunk' },
    })).toBe('remotes/origin/trunk');
  });

  test('falls back to main or master on the default remote when its HEAD is unknown', () => {
    expect(resolveRemoteDefaultStartRef({ all: ['remotes/origin/master', 'remotes/origin/feature'], defaultBranches: {} }))
      .toBe('remotes/origin/master');
  });

  test('uses the first remote by name when there is no origin', () => {
    expect(resolveRemoteDefaultStartRef({
      all: ['remotes/upstream/dev', 'remotes/fork/main'],
      defaultBranches: { upstream: 'dev' },
    })).toBe('remotes/fork/main');
  });

  test('only the default remote counts, so origin without a default branch is no default', () => {
    expect(resolveRemoteDefaultStartRef({
      all: ['remotes/origin/develop', 'remotes/upstream/main'],
      defaultBranches: { upstream: 'main' },
    })).toBeNull();
  });

  test('is null when no remote names a default branch', () => {
    expect(resolveRemoteDefaultStartRef({ all: ['main', 'remotes/origin/feature'], defaultBranches: {} })).toBeNull();
    expect(resolveRemoteDefaultStartRef({ all: ['main'] })).toBeNull();
  });
});

describe('formatStartRefLabel', () => {
  test('shows a remote branch the way git names it on the command line', () => {
    expect(formatStartRefLabel('remotes/origin/main')).toBe('origin/main');
    expect(formatStartRefLabel('feature/login')).toBe('feature/login');
  });
});

describe('groupStartSourceBranches', () => {
  test('lists a branch once: under its worktree, else as a local or a remote branch', () => {
    expect(groupStartSourceBranches(
      ['main', 'feature/a', 'spike', 'unpushed', 'remotes/origin/HEAD', 'remotes/origin/main', 'remotes/upstream/dev'],
      'main',
      ['feature/a', '', 'main'],
    )).toEqual({
      checkedOut: ['main', 'feature/a'],
      local: ['spike', 'unpushed'],
      remote: ['origin/main', 'upstream/dev'],
    });
  });

  test('a detached project root contributes no worktree branch', () => {
    expect(groupStartSourceBranches(['main'], '', []).checkedOut).toEqual([]);
  });
});

describe('checkPullRequestSource', () => {
  const context = {
    provider: 'github' as const,
    instance: 'github.com',
    directory: '/repo',
    repositoryId: 'repo-1',
    accountId: 'account-1',
    bindingRevision: 1,
    primaryRemote: 'origin',
  };
  const project = { provider: 'github' as const, instance: 'github.com', id: 'acme/app', owner: 'acme', name: 'app', url: 'https://github.com/acme/app' };
  const changeRequest = (state: 'open' | 'closed' | 'merged', fork: boolean) => ({
    provider: 'github' as const,
    instance: 'github.com',
    id: '42',
    number: 42,
    project,
    headProject: fork ? { ...project, id: 'octo/app', owner: 'octo', url: 'https://github.com/octo/app' } : project,
    title: 'Fix login',
    url: 'https://github.com/acme/app/pull/42',
    state,
    draft: false,
    base: 'main',
    head: 'fix-login',
    headSha: 'abc1234',
  });
  const check = (options: {
    found?: boolean;
    state?: 'open' | 'closed' | 'merged';
    fork?: boolean;
    inUse?: boolean;
    mode?: 'check-out' | 'branch-off';
  }) => {
    const checkedBranches: string[] = [];
    const result = checkPullRequestSource({
      context,
      number: 42,
      mode: options.mode ?? 'check-out',
      readChangeRequest: async () => (options.found === false ? null : changeRequest(options.state ?? 'open', options.fork === true)),
      isBranchInUse: async (branch) => {
        checkedBranches.push(branch);
        return options.inUse === true;
      },
    });
    return { result, checkedBranches };
  };
  const picked = (fields: { fromFork: boolean; headInUse: boolean; branchOff: boolean }) => ({
    ok: true,
    source: { kind: 'pull-request', number: 42, title: 'Fix login', context, ...fields },
  });

  test('starts on the Settings mode when the pull request allows it', async () => {
    const checkOut = check({});
    expect(await checkOut.result).toEqual(picked({ fromFork: false, headInUse: false, branchOff: false }));
    expect(checkOut.checkedBranches).toEqual(['fix-login']);
    expect(await check({ mode: 'branch-off' }).result).toEqual(picked({ fromFork: false, headInUse: false, branchOff: true }));
  });

  test('a fork\'s pull request is only checked out; one whose branch is open elsewhere is only branched off', async () => {
    expect(await check({ fork: true, mode: 'branch-off' }).result).toEqual(picked({ fromFork: true, headInUse: false, branchOff: false }));
    expect(await check({ inUse: true }).result).toEqual(picked({ fromFork: false, headInUse: true, branchOff: true }));
  });

  test('says why a pull request cannot be the source', async () => {
    expect(await check({ found: false }).result).toEqual({ ok: false, reason: 'not-found' });
    expect(await check({ state: 'merged' }).result).toEqual({ ok: false, reason: 'not-open' });
    expect(await check({ fork: true, inUse: true }).result).toEqual({ ok: false, reason: 'branch-in-use' });
  });
});

describe('selectWorktreeStartFrom', () => {
  test('a place\'s override wins over the default for all', () => {
    const settings = { settingsWorktreeStartFrom: 'remote-default' as const, settingsWorktreeStartFromOverrides: { quick: 'project-root' as const } };
    expect(selectWorktreeStartFrom(settings, 'quick')).toBe('project-root');
    expect(selectWorktreeStartFrom(settings, 'dialog')).toBe('remote-default');
  });
});
