import { create } from 'zustand';

// Narrow store for the "next message starts a goal" flag. Armed by the
// composer target button (works for existing sessions AND session drafts)
// and by the run-as-goal flows (fork dialog, plan send); consumed by
// sendMessage in session-ui-store, which turns the sent prompt into the
// goal objective — unless the arming flow supplied a richer objective
// override (e.g. the plan content instead of "Implement this plan: X").
interface SessionGoalArm {
  armed: boolean;
  objectiveOverride: string | null;
  /**
   * The objective is settled: the goal writer produced it, or the user chose
   * their own text over it. "Rewrite every goal" leaves a settled objective alone.
   */
  settled: boolean;
  /**
   * The sent message is not the objective (a written spec sent with the
   * original message), so the goal reminder carries the objective to the agent.
   */
  briefAgent: boolean;
  /** The user switched the goal length limit off for this goal. */
  ignoreLimit: boolean;
}

interface SessionGoalArmStore extends SessionGoalArm {
  setArmed: (
    armed: boolean,
    objectiveOverride?: string | null,
    options?: { settled?: boolean; briefAgent?: boolean; ignoreLimit?: boolean },
  ) => void;
  /** Read-and-clear in one step at send time. */
  consume: () => SessionGoalArm;
}

const DISARMED: SessionGoalArm = { armed: false, objectiveOverride: null, settled: false, briefAgent: false, ignoreLimit: false };

export const useSessionGoalArmStore = create<SessionGoalArmStore>((set, get) => ({
  ...DISARMED,
  setArmed: (armed, objectiveOverride = null, options = {}) => set(armed
    ? {
        armed,
        objectiveOverride,
        settled: options.settled === true,
        briefAgent: options.briefAgent === true && Boolean(objectiveOverride),
        ignoreLimit: options.ignoreLimit === true,
      }
    : DISARMED),
  consume: () => {
    const { armed, objectiveOverride, settled, briefAgent, ignoreLimit } = get();
    if (armed) set(DISARMED);
    return { armed, objectiveOverride, settled, briefAgent, ignoreLimit };
  },
}));
