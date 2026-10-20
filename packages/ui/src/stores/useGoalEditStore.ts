import { create } from 'zustand';
import type { GoalWriterChoice } from '@/lib/goalWriter';

/** How a message sent with a goal change reaches a session that is working. */
export type GoalEditDelivery = 'steer' | 'queue';

/** What the goal editor held when the user saved: kept until the save lands, so the editor can reopen with it. */
export interface GoalEditDraft {
  objective: string;
  tokenBudget: number | null;
  ignoreLimit: boolean;
  /** Null keeps the default writer (Settings, else the session's model). */
  writer: GoalWriterChoice | null;
  /** Sent to the agent with the change; empty sends nothing. */
  message: string;
  delivery: GoalEditDelivery;
}

/**
 * A goal save running after the editor closed, one per session. `saving`
 * names the writer when the goal writer rewrites the objective, so the card
 * can say whose turn it is; the other states keep the draft for reopening.
 */
export type GoalEditJob =
  | { status: 'saving'; jobId: number; rewriting: boolean; writerLabel: string | null; draft: GoalEditDraft }
  /** The goal changed elsewhere while this edit was written; nothing was saved. */
  | { status: 'changed'; jobId: number; draft: GoalEditDraft }
  | { status: 'failed'; jobId: number; reason: string; draft: GoalEditDraft;
    /** `message`: the goal was saved and only the message did not go out. */
    stage: 'goal' | 'message' };

interface GoalEditStore {
  jobs: Record<string, GoalEditJob>;
  /** A draft the user cancelled or must review again, by session. */
  drafts: Record<string, GoalEditDraft>;
  setJob: (sessionId: string, job: GoalEditJob) => void;
  /** Ends a job; only the job it names, so a newer save is never cleared by an older one. */
  finishJob: (sessionId: string, jobId: number, keepDraft: GoalEditDraft | null) => void;
  /** The editor opened with the kept draft, or the user dismissed it. */
  clearDraft: (sessionId: string) => void;
}

const without = <T,>(record: Record<string, T>, key: string) => {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
};

export const useGoalEditStore = create<GoalEditStore>((set) => ({
  jobs: {},
  drafts: {},
  setJob: (sessionId, job) => set((state) => ({ jobs: { ...state.jobs, [sessionId]: job }, drafts: without(state.drafts, sessionId) })),
  finishJob: (sessionId, jobId, keepDraft) => set((state) => {
    if (state.jobs[sessionId]?.jobId !== jobId) return state;
    return {
      jobs: without(state.jobs, sessionId),
      drafts: keepDraft ? { ...state.drafts, [sessionId]: keepDraft } : state.drafts,
    };
  }),
  clearDraft: (sessionId) => set((state) => ({ drafts: without(state.drafts, sessionId) })),
}));
