import { afterEach, describe, expect, test } from 'bun:test';

import {
  generateAutoWorktreeName,
  parseAutoWorktreeName,
  shouldAutoCreateDraftWorktree,
  toAutoWorktreeCreateArgs,
  toPullRequestBranchOffArgs,
  toPullRequestWorktreeArgs,
} from './autoDraftWorktree';

const projectDraft = {
  open: true,
  target: 'project' as const,
  directoryOverride: '/repo',
  pendingWorktreeRequestId: null,
  bootstrapPendingDirectory: null,
};

describe('parseAutoWorktreeName', () => {
  test('an empty field asks for a generated name', () => {
    expect(parseAutoWorktreeName(undefined)).toEqual({ kind: 'generate' });
    expect(parseAutoWorktreeName('   ')).toEqual({ kind: 'generate' });
  });

  test('a leading / is an exact path, anything else a name', () => {
    expect(parseAutoWorktreeName(' /work/fix-login ')).toEqual({ kind: 'path', path: '/work/fix-login' });
    expect(parseAutoWorktreeName(' fix login ')).toEqual({ kind: 'name', name: 'fix login' });
  });
});

describe('toAutoWorktreeCreateArgs', () => {
  test('a name is the branch and the directory name, like Quick worktree', () => {
    expect(toAutoWorktreeCreateArgs({ kind: 'name', name: 'fix-login' }))
      .toEqual({ preferredName: 'fix-login', branchName: 'fix-login', worktreeName: 'fix-login' });
  });

  test('a path is passed only as the worktree name, so it never becomes a branch', () => {
    expect(toAutoWorktreeCreateArgs({ kind: 'path', path: '/work/fix-login' })).toEqual({ worktreeName: '/work/fix-login' });
  });
});

describe('toPullRequestWorktreeArgs', () => {
  const config = {
    existingBranch: 'remotes/pr-octo/fix-login',
    expectedRevision: 'abc1234',
    changeRequestSource: {
      context: {
        provider: 'github' as const,
        instance: 'github.com',
        directory: '/repo',
        repositoryId: 'repo-1',
        accountId: 'account-1',
        bindingRevision: 1,
        primaryRemote: 'origin',
      },
      project: { id: 'acme/app', owner: 'acme', name: 'app' },
      number: 42,
      expectedHeadSha: 'abc1234',
      requestedRemoteName: 'pr-octo',
    },
    sourceLabel: 'fix-login',
  };

  test('checks out the pull request\'s own branch in a folder named after it', () => {
    expect(toPullRequestWorktreeArgs(config, { kind: 'generate' })).toEqual({
      mode: 'existing',
      preferredName: 'fix-login',
      branchName: 'fix-login',
      worktreeName: 'fix-login',
      existingBranch: 'remotes/pr-octo/fix-login',
      expectedRevision: 'abc1234',
      changeRequestSource: config.changeRequestSource,
    });
  });

  test('branching off names a new branch like any auto-created worktree and leaves the start to the server', () => {
    expect(toPullRequestBranchOffArgs(config, { kind: 'name', name: 'follow-up' })).toEqual({
      mode: 'new',
      preferredName: 'follow-up',
      branchName: 'follow-up',
      worktreeName: 'follow-up',
      changeRequestSource: config.changeRequestSource,
    });
  });

  test('a typed name or path names only the folder; the branch stays the pull request\'s', () => {
    expect(toPullRequestWorktreeArgs(config, { kind: 'name', name: 'review-42' }))
      .toMatchObject({ branchName: 'fix-login', worktreeName: 'review-42', existingBranch: 'remotes/pr-octo/fix-login' });
    expect(toPullRequestWorktreeArgs(config, { kind: 'path', path: '/work/review-42' }))
      .toMatchObject({ branchName: 'fix-login', worktreeName: '/work/review-42' });
  });
});

describe('shouldAutoCreateDraftWorktree', () => {
  const base = { enabled: true, draft: projectDraft, projectPath: '/repo', isGitRepo: true };

  test('applies to a git project draft aimed at the project root', () => {
    expect(shouldAutoCreateDraftWorktree(base)).toBe(true);
    expect(shouldAutoCreateDraftWorktree({ ...base, draft: { ...projectDraft, directoryOverride: null } })).toBe(true);
    expect(shouldAutoCreateDraftWorktree({ ...base, draft: { ...projectDraft, directoryOverride: '/repo/' } })).toBe(true);
  });

  test('does nothing when off, outside a git repository, or for a chat draft', () => {
    expect(shouldAutoCreateDraftWorktree({ ...base, enabled: false })).toBe(false);
    expect(shouldAutoCreateDraftWorktree({ ...base, isGitRepo: false })).toBe(false);
    expect(shouldAutoCreateDraftWorktree({ ...base, isGitRepo: null })).toBe(false);
    expect(shouldAutoCreateDraftWorktree({ ...base, draft: { ...projectDraft, target: 'chat' } })).toBe(false);
  });

  test('leaves a draft that already targets a worktree alone', () => {
    expect(shouldAutoCreateDraftWorktree({ ...base, draft: { ...projectDraft, directoryOverride: '/worktrees/feature' } })).toBe(false);
    expect(shouldAutoCreateDraftWorktree({ ...base, draft: { ...projectDraft, pendingWorktreeRequestId: 'worktree_1' } })).toBe(false);
    expect(shouldAutoCreateDraftWorktree({ ...base, draft: { ...projectDraft, bootstrapPendingDirectory: '/worktrees/feature' } })).toBe(false);
  });
});

describe('generateAutoWorktreeName', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const stubFetch = (respond: (url: string, init?: RequestInit) => Promise<Response>) => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return respond(url, init);
    };
    return calls;
  };

  test('asks the server with the prompt and the model the prompt is sent with', async () => {
    const calls = stubFetch(async () => Response.json({ name: 'fix-login-redirect' }));
    expect(await generateAutoWorktreeName('/repo', 'Fix the login redirect', 'anthropic/claude')).toBe('fix-login-redirect');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/git/worktrees/generate-name');
    expect(calls[0].url).toContain('directory=%2Frepo');
    expect(calls[0].body).toEqual({ prompt: 'Fix the login redirect', model: 'anthropic/claude' });
  });

  test('every failure is an empty name, never an error', async () => {
    stubFetch(async () => Response.json({ name: '' }));
    expect(await generateAutoWorktreeName('/repo', 'x', 'p/m')).toBe('');
    stubFetch(async () => new Response('nope', { status: 500 }));
    expect(await generateAutoWorktreeName('/repo', 'x', 'p/m')).toBe('');
    stubFetch(async () => Response.json({ unexpected: true }));
    expect(await generateAutoWorktreeName('/repo', 'x', 'p/m')).toBe('');
    stubFetch(async () => { throw new TypeError('Failed to fetch'); });
    expect(await generateAutoWorktreeName('/repo', 'x', 'p/m')).toBe('');
  });
});
