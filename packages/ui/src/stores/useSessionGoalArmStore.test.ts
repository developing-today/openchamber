import { beforeEach, describe, expect, test } from 'bun:test';
import { rearmQueuedGoal, useSessionGoalArmStore } from './useSessionGoalArmStore';

describe('rearmQueuedGoal', () => {
  beforeEach(() => useSessionGoalArmStore.getState().setArmed(false));

  test('arms the composer with the queued goal and its flags', () => {
    rearmQueuedGoal({ objective: 'Approved spec', settled: true, briefAgent: true, ignoreLimit: true });
    expect(useSessionGoalArmStore.getState().consume()).toEqual({
      armed: true, objectiveOverride: 'Approved spec', settled: true, briefAgent: true, ignoreLimit: true,
    });
  });

  test('a goal queued without flags or objective comes back plain', () => {
    rearmQueuedGoal({});
    expect(useSessionGoalArmStore.getState().consume()).toEqual({
      armed: true, objectiveOverride: null, settled: false, briefAgent: false, ignoreLimit: false,
    });
  });
});
