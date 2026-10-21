import { create } from 'zustand';

// Narrow store for the "next message starts a goal" flag. Armed by the
// composer target button (works for existing sessions AND session drafts);
// consumed by sendMessage in session-ui-store, which turns the sent prompt
// into the goal objective — unless the arm carries a richer objective
// override (e.g. the plan content instead of "Implement this plan: X"). The
// composer consumes it itself for a message that goes to the goal writer or
// into the message queue, which then carries the goal to its delivery.
// Sends that bring their own goal (the goal writer card, the run-as-goal
// flows of the fork dialog and the plan send) pass an arm to sendMessage
// instead and leave this store alone.
export interface SessionGoalArm {
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
}

interface SessionGoalArmStore extends SessionGoalArm {
  setArmed: (
    armed: boolean,
    objectiveOverride?: string | null,
    options?: { settled?: boolean; briefAgent?: boolean },
  ) => void;
  /** Read-and-clear in one step at send time. */
  consume: () => SessionGoalArm;
}

const DISARMED: SessionGoalArm = { armed: false, objectiveOverride: null, settled: false, briefAgent: false };

/**
 * An arm as `setArmed` stores it. A send that brings its own goal passes one
 * to `sendMessage` (`goalArm`) instead of arming this store.
 */
export const createGoalArm = (
  armed: boolean,
  objectiveOverride: string | null = null,
  options: { settled?: boolean; briefAgent?: boolean } = {},
): SessionGoalArm => (armed
  ? {
      armed,
      objectiveOverride,
      settled: options.settled === true,
      briefAgent: options.briefAgent === true && Boolean(objectiveOverride),
    }
  : DISARMED);

export const useSessionGoalArmStore = create<SessionGoalArmStore>((set, get) => ({
  ...DISARMED,
  setArmed: (armed, objectiveOverride, options) => set(createGoalArm(armed, objectiveOverride, options)),
  consume: () => {
    const { armed, objectiveOverride, settled, briefAgent } = get();
    if (armed) set(DISARMED);
    return { armed, objectiveOverride, settled, briefAgent };
  },
}));
