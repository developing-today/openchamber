import { describe, expect, it } from 'vitest';

import { resolveRemoteDefaultStartRef, resolveWorktreeStartFrom, sanitizeWorktreeStartFromOverrides } from './worktree-start-ref.js';

describe('resolveRemoteDefaultStartRef', () => {
  it('takes the branch origin\'s HEAD points at, before any other remote', () => {
    expect(resolveRemoteDefaultStartRef({
      all: ['main', 'remotes/upstream/main', 'remotes/origin/trunk'],
      defaultBranches: { upstream: 'main', origin: 'trunk' },
    })).toBe('remotes/origin/trunk');
  });

  it('falls back to main or master on the default remote when its HEAD is unknown', () => {
    expect(resolveRemoteDefaultStartRef({ all: ['remotes/origin/master', 'remotes/origin/feature'], defaultBranches: {} }))
      .toBe('remotes/origin/master');
  });

  it('uses the first remote by name when there is no origin', () => {
    expect(resolveRemoteDefaultStartRef({
      all: ['remotes/upstream/dev', 'remotes/fork/main'],
      defaultBranches: { upstream: 'dev' },
    })).toBe('remotes/fork/main');
  });

  it('only the default remote counts, so origin without a default branch is no default', () => {
    expect(resolveRemoteDefaultStartRef({
      all: ['remotes/origin/develop', 'remotes/upstream/main'],
      defaultBranches: { upstream: 'main' },
    })).toBeNull();
  });

  it('is null when no remote names a default branch', () => {
    expect(resolveRemoteDefaultStartRef({ all: ['main', 'remotes/origin/feature'], defaultBranches: {} })).toBeNull();
    expect(resolveRemoteDefaultStartRef({ all: ['main'] })).toBeNull();
  });
});

describe('resolveWorktreeStartFrom', () => {
  it('takes the place\'s override, else the default for all, else the default remote\'s default branch', () => {
    expect(resolveWorktreeStartFrom({}, 'agent')).toBe('remote-default');
    expect(resolveWorktreeStartFrom({ worktreeStartFrom: 'project-root' }, 'agent')).toBe('project-root');
    expect(resolveWorktreeStartFrom({ worktreeStartFrom: 'project-root', worktreeStartFromOverrides: { agent: 'remote-default' } }, 'agent'))
      .toBe('remote-default');
    expect(resolveWorktreeStartFrom({ worktreeStartFrom: 'sideways', worktreeStartFromOverrides: { agent: 'nowhere' } }, 'agent'))
      .toBe('remote-default');
  });
});

describe('sanitizeWorktreeStartFromOverrides', () => {
  it('keeps known places with known values and drops the rest', () => {
    expect(sanitizeWorktreeStartFromOverrides({ quick: 'project-root', agent: 'sideways', elsewhere: 'remote-default' }))
      .toEqual({ quick: 'project-root' });
    expect(sanitizeWorktreeStartFromOverrides(['quick'])).toBeUndefined();
    expect(sanitizeWorktreeStartFromOverrides(null)).toBeUndefined();
  });
});
