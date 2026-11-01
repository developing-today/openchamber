import { describe, expect, test } from 'bun:test';
import type { Metadata } from '@/lib/opencode/model';
import type { SessionGoalPayload } from '@/lib/sessionGoalMetadata';

const { nextGoalRecord } = await import('./sessionGoalActions');

const existing: SessionGoalPayload = {
  id: 'goal-1',
  objective: 'Old objective',
  objectiveFile: true,
  objectiveRevision: 'rev-a',
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
  objectiveRevision: 'rev-new',
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
  // The server runtime stamps a fresh updatedAt on every accounting
  // merge-write, so a settlement landing while the editor is open must not
  // read as somebody else editing the goal.
  test('an accounting bump after the edit began is not a conflicting edit', () => {
    const next = save({ ...stored, updatedAt: 999, tokensUsed: 1500, turnsUsed: 5, lastAccountedMessageID: 'msg-10' });
    expect(next).toMatchObject({ changed: false, record: { id: 'goal-1', tokensUsed: 1500, turnsUsed: 5 } });
  });

  test('a genuine objective change after the edit began is still refused', () => {
    const inlineExisting = { ...existing, objectiveFile: false };
    expect(save({ ...stored, objective: 'Old objective' }, { existing: inlineExisting }).changed).toBe(false);
    expect(save({ ...stored, objective: 'Rewritten elsewhere' }, { existing: inlineExisting })).toEqual({ changed: true });
  });

  // File-backed goals carry no objective text in the record, so an
  // intervening save is detected by the objective revision it stamps:
  // accounting preserves the revision, a save replaces it.
  test('a file-backed goal whose objective was saved elsewhere is refused', () => {
    expect(save({ ...stored, objectiveRevision: 'rev-b', updatedAt: 999 })).toEqual({ changed: true });
  });

  test('an accounting bump on a file-backed goal keeps its revision and is not a conflict', () => {
    const next = save({ ...stored, objectiveRevision: 'rev-a', updatedAt: 999, tokensUsed: 1500 });
    expect(next).toMatchObject({ changed: false, record: { objectiveRevision: 'rev-new', tokensUsed: 1500 } });
  });

  // Budget and limit flag are user-editable settings an accounting
  // merge-write cannot change; another window lowering the budget while
  // this edit is open is a real conflict, not an accounting bump.
  test('a budget or limit change after the edit began is a conflicting edit', () => {
    expect(save({ ...stored, tokenBudget: 5000 })).toEqual({ changed: true });
    expect(save({ ...stored, ignoreObjectiveLimit: true })).toEqual({ changed: true });
  });

  test('an edit begun after the budget was set still saves over accounting bumps', () => {
    const budgeted = { ...existing, tokenBudget: 5000, ignoreObjectiveLimit: true };
    const next = save(
      { ...stored, tokenBudget: 5000, ignoreObjectiveLimit: true, updatedAt: 999, tokensUsed: 1500 },
      { existing: budgeted },
    );
    expect(next).toMatchObject({ changed: false, record: { id: 'goal-1', tokensUsed: 1500 } });
  });

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
