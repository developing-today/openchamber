import { describe, expect, test } from 'bun:test';
import type { Metadata } from '@/lib/opencode/model';
import type { SessionGoalPayload } from '@/lib/sessionGoalMetadata';

const { nextGoalRecord } = await import('./sessionGoalActions');

const existing: SessionGoalPayload = {
  id: 'goal-1',
  objective: 'Old objective',
  objectiveFile: true,
  ignoreObjectiveLimit: false,
  status: 'active',
  tokenBudget: null,
  tokensUsed: 900,
  turnsUsed: 4,
  statusReason: '',
  evaluationProviderID: '',
  evaluationModelID: '',
  lastAccountedMessageID: 'msg-9',
  createdAt: 1,
  updatedAt: 50,
};

const stored = { id: 'goal-1', status: 'active', updatedAt: 50, tokensUsed: 900, turnsUsed: 4, lastAccountedMessageID: 'msg-9' };

const save = (currentGoal: Metadata | null, overrides: Partial<Parameters<typeof nextGoalRecord>[0]> = {}) => nextGoalRecord({
  currentGoal,
  existing,
  objective: '',
  objectiveFile: true,
  ignoreLimit: false,
  tokenBudget: null,
  kickoff: true,
  now: 100,
  newId: 'goal-2',
  ...overrides,
});

describe('goal record for a save', () => {
  test('an edit keeps the goal and its usage, and reactivates it', () => {
    expect(save(stored)).toMatchObject({
      changed: false,
      record: { id: 'goal-1', tokensUsed: 900, turnsUsed: 4, status: 'active', statusReason: 'resumed', updatedAt: 100 },
    });
  });

  test('an edit sent with a message does not ask for an immediate check', () => {
    const next = save(stored, { kickoff: false });
    expect(next.changed ? null : next.record.statusReason).toBe('');
  });

  // A rewrite can take minutes: the check may complete the goal, the user may
  // pause it, another window may replace it. Saving over any of those would
  // reactivate an outcome or reset another goal's usage.
  test('an edit is refused when the stored goal changed after it began', () => {
    expect(save({ ...stored, status: 'complete' })).toEqual({ changed: true });
    expect(save({ ...stored, status: 'paused', updatedAt: 60 })).toEqual({ changed: true });
    expect(save({ ...stored, id: 'goal-other' })).toEqual({ changed: true });
    expect(save(null)).toEqual({ changed: true });
  });

  test('a new goal states its length limit choice, so the replaced goal cannot pass it on', () => {
    const next = save({ ...stored, ignoreObjectiveLimit: true }, { existing: null });
    expect(next).toMatchObject({
      changed: false,
      record: { id: 'goal-2', ignoreObjectiveLimit: false, tokensUsed: 0, turnsUsed: 0, statusReason: '' },
    });
  });
});
