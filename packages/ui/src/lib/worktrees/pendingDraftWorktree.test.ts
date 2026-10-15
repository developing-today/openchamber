import { describe, expect, test } from 'bun:test';

import {
  createPendingDraftWorktreeRequest,
  rejectPendingDraftWorktreeRequest,
  resolvePendingDraftWorktreeRequest,
  waitForPendingDraftWorktreeRequest,
} from './pendingDraftWorktree';

describe('pending draft worktree requests', () => {
  test('a kept result reaches a send that starts waiting after it settled', async () => {
    const resolved = createPendingDraftWorktreeRequest();
    resolvePendingDraftWorktreeRequest(resolved, '/worktrees/a', { keep: true });
    expect(await waitForPendingDraftWorktreeRequest(resolved)).toBe('/worktrees/a');

    const failed = createPendingDraftWorktreeRequest();
    rejectPendingDraftWorktreeRequest(failed, new Error('Worktree path already exists: /x'), { keep: true });
    await expect(waitForPendingDraftWorktreeRequest(failed)).rejects.toThrow('Worktree path already exists: /x');
  });

  test('an early waiter gets the failure itself', async () => {
    const id = createPendingDraftWorktreeRequest();
    const waiting = waitForPendingDraftWorktreeRequest(id);
    rejectPendingDraftWorktreeRequest(id, new Error('boom'), { keep: true });
    await expect(waiting).rejects.toThrow('boom');
  });
});
