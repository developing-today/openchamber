import { beforeEach, describe, expect, test } from 'bun:test';
import { useGoalEditStore, type GoalEditDraft } from './useGoalEditStore';

const draft: GoalEditDraft = { objective: 'Ship it', tokenBudget: null, ignoreLimit: false, writer: null, message: '', delivery: 'steer' };

describe('goal edit jobs', () => {
  beforeEach(() => useGoalEditStore.setState({ jobs: {}, drafts: {} }));

  test('an older save ending does not clear a newer one', () => {
    const store = useGoalEditStore.getState();
    store.setJob('s1', { status: 'saving', jobId: 1, rewriting: true, writerLabel: null, draft });
    store.setJob('s1', { status: 'saving', jobId: 2, rewriting: true, writerLabel: null, draft });
    store.finishJob('s1', 1, null);
    expect(useGoalEditStore.getState().jobs.s1?.jobId).toBe(2);
    store.finishJob('s1', 2, null);
    expect(useGoalEditStore.getState().jobs.s1).toBeUndefined();
  });

  test('a cancelled save keeps its draft for the editor, and a new save replaces it', () => {
    const store = useGoalEditStore.getState();
    store.setJob('s1', { status: 'saving', jobId: 3, rewriting: true, writerLabel: null, draft });
    store.finishJob('s1', 3, draft);
    expect(useGoalEditStore.getState().drafts.s1).toEqual(draft);
    store.setJob('s1', { status: 'saving', jobId: 4, rewriting: false, writerLabel: null, draft });
    expect(useGoalEditStore.getState().drafts.s1).toBeUndefined();
  });
});
