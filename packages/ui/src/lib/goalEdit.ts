import { buildGoalUpdateReminder } from '@/lib/goalWriter';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { setSessionGoal } from '@/lib/sessionGoalActions';
import type { SessionGoalPayload } from '@/lib/sessionGoalMetadata';
import { useGoalEditStore, type GoalEditDraft } from '@/stores/useGoalEditStore';
import { createMessageQueueTarget, useMessageQueueStore } from '@/stores/messageQueueStore';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { getSessionDirectory } from '@/sync/session-actions';
import { routeMessage } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';

// A goal edit saved from the goal editor runs here after the editor closed:
// the goal writer may take minutes, and the card above the composer
// (`GoalEditStrip`) shows it, cancels it, and reopens the editor when it
// cannot land. One save per session; a newer one cancels the older.

let lastJobId = 0;
const running = new Map<string, { jobId: number; controller: AbortController }>();

export interface StartGoalEditInput {
  sessionId: string;
  directory: string | undefined;
  draft: GoalEditDraft;
  /** The goal the edit started from; null creates a new goal. */
  existing: SessionGoalPayload | null;
  /** Run the objective through the goal writer ("rewrite every goal"). */
  rewrite: boolean;
  /** The session's model: the writer falls back to it, and the message goes out on it. */
  sessionModel: { providerID: string; modelID: string } | null;
  /** Shown on the card while the writer works, such as `anthropic/claude · low`. */
  writerLabel: string | null;
}

/**
 * Sends the message written with a goal change. On an idle session it starts
 * the next turn; on a working one it steers into the running turn, or waits
 * in the session's queue until the turn ends. It carries the changed goal, so
 * the agent works the message against it.
 */
const sendGoalEditMessage = async (input: {
  sessionId: string;
  directory: string | undefined;
  runtimeKey: string;
  draft: GoalEditDraft;
  objective: string;
  sessionModel: { providerID: string; modelID: string } | null;
}): Promise<void> => {
  const { sessionId, draft, sessionModel } = input;
  if (!sessionModel) throw new Error('The session has no model to send the message with');
  if (getRuntimeKey() !== input.runtimeKey) throw new Error('The message was not sent because the runtime changed');
  const directory = input.directory ?? getSessionDirectory(sessionId);
  const reminder = buildGoalUpdateReminder(draft.tokenBudget, input.objective);
  const agent = useSelectionStore.getState().getSessionAgentSelection(sessionId) ?? undefined;
  // Read now, not when the editor opened: the turn may have ended meanwhile.
  const busy = useGlobalSessionStatusStore.getState().activeSessionIds.has(sessionId);
  if (busy && draft.delivery === 'queue') {
    const target = createMessageQueueTarget(sessionId, directory, input.runtimeKey);
    if (!target) throw new Error('The session has no directory to queue the message in');
    await useMessageQueueStore.getState().addToQueue(target, {
      content: draft.message,
      context: [{ kind: 'synthetic', text: reminder }],
      sendConfig: { ...sessionModel, agent },
    });
    return;
  }
  await routeMessage({
    runtimeKey: input.runtimeKey,
    sessionId,
    directory,
    content: draft.message,
    providerID: sessionModel.providerID,
    modelID: sessionModel.modelID,
    agent,
    additionalParts: [{ text: reminder, synthetic: true }],
    delivery: busy ? 'steer' : undefined,
  });
};

export function startGoalEdit(input: StartGoalEditInput): void {
  const { sessionId, draft } = input;
  running.get(sessionId)?.controller.abort();
  lastJobId += 1;
  const jobId = lastJobId;
  const controller = new AbortController();
  running.set(sessionId, { jobId, controller });
  const store = useGoalEditStore.getState();
  store.setJob(sessionId, { status: 'saving', jobId, rewriting: input.rewrite, writerLabel: input.rewrite ? input.writerLabel : null, draft });
  const runtimeKey = getRuntimeKey();
  const isCurrent = () => useGoalEditStore.getState().jobs[sessionId]?.jobId === jobId;
  const message = draft.message.trim();

  const run = async () => {
    let goalSaved = false;
    try {
      const result = await setSessionGoal(sessionId, input.directory, {
        objective: draft.objective,
        tokenBudget: draft.tokenBudget,
        ignoreLimit: draft.ignoreLimit,
        // The message starts the next turn itself.
        kickoff: !message,
        rewrite: input.rewrite
          ? { providerID: input.sessionModel?.providerID, modelID: input.sessionModel?.modelID, writer: draft.writer }
          : null,
        signal: controller.signal,
      }, input.existing);
      if (result.outcome === 'changed') {
        if (isCurrent()) store.setJob(sessionId, { status: 'changed', jobId, draft });
        return;
      }
      goalSaved = true;
      if (message && controller.signal.aborted) {
        // Cancelled after the goal was written: the message stays unsent, in
        // the draft the editor reopens with.
        useGoalEditStore.getState().finishJob(sessionId, jobId, draft);
        return;
      }
      if (message) {
        await sendGoalEditMessage({
          sessionId,
          directory: input.directory,
          runtimeKey,
          draft: { ...draft, message },
          objective: result.rewrittenSpec ?? draft.objective.trim(),
          sessionModel: input.sessionModel,
        });
      }
      useGoalEditStore.getState().finishJob(sessionId, jobId, null);
    } catch (error) {
      if (controller.signal.aborted && !goalSaved) {
        // Cancelled before anything was written: the editor reopens with the draft.
        useGoalEditStore.getState().finishJob(sessionId, jobId, draft);
        return;
      }
      console.warn('[session-goal] goal edit failed:', error);
      if (isCurrent()) {
        useGoalEditStore.getState().setJob(sessionId, { status: 'failed', jobId, reason: error instanceof Error ? error.message : String(error), draft, stage: goalSaved ? 'message' : 'goal' });
      }
    } finally {
      if (running.get(sessionId)?.jobId === jobId) running.delete(sessionId);
    }
  };
  void run();
}

/** Stops a save still in progress; once the goal is written, only the message can still be skipped. */
export function cancelGoalEdit(sessionId: string): void {
  running.get(sessionId)?.controller.abort();
}
