/**
 * How long a goal objective may be, and how much of it the progress check
 * reads. The server applies the same bounds (`goalObjectiveLimits` in
 * `session-goal/objectives.js`) and reads both from Settings itself.
 */
export const DEFAULT_SESSION_GOAL_OBJECTIVE_CHAR_LIMIT = 5_000;
export const DEFAULT_SESSION_GOAL_CHECK_OBJECTIVE_CHAR_LIMIT = 20_000;
export const SESSION_GOAL_CHAR_LIMIT_MIN = 1_000;
/** Also the most a goal keeps when its limit is switched off. */
export const SESSION_GOAL_CHAR_LIMIT_MAX = 1_000_000;

export const isSessionGoalCharLimit = (value: number): boolean => (
  Number.isInteger(value) && value >= SESSION_GOAL_CHAR_LIMIT_MIN && value <= SESSION_GOAL_CHAR_LIMIT_MAX
);
