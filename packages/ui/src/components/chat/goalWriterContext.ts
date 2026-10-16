import type { ProjectRef } from '@/lib/projectContextApi';
import { fetchSessionKnowledgeSummary } from '@/lib/sessionKnowledgeApi';
import { formatGoalWriterConversation, formatGoalWriterOpenItems } from '@/lib/goalWriter';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { getSessionLastAssistantModel } from '@/sync/session-actions';
import { useSelectionStore } from '@/sync/selection-store';
import { buildSessionMessageRecordsSnapshot } from '@/sync/sync-context';
import { getAllSyncSessions, getDirectoryState } from '@/sync/sync-refs';

/**
 * The model a session works with, for the goal writer to fall back on: the
 * composer's pick for the session, else the model of its last reply, else the
 * current picker.
 */
export function resolveSessionWriterModel(sessionId: string) {
  const picked = useSelectionStore.getState().getSessionModelSelection(sessionId);
  if (picked) return { providerID: picked.providerId, modelID: picked.modelId };
  const replied = getSessionLastAssistantModel(sessionId);
  if (replied) return replied;
  const { currentProviderId, currentModelId } = useConfigStore.getState();
  return { providerID: currentProviderId || null, modelID: currentModelId || null };
}

/**
 * What "start a goal from the next message" hands the writer besides the
 * message: the session's earlier requests and answers, and the open work
 * around it. Best effort: a source that cannot be read leaves its part out,
 * since the message alone still makes a goal.
 */
export async function collectGoalWriterContext(input: {
  sessionId: string | null;
  directory: string | null;
  project: ProjectRef | null;
  queuedMessages: readonly string[];
}): Promise<{ conversation: string; openItems: string }> {
  const { sessionId, directory, project } = input;
  const state = sessionId && directory ? getDirectoryState(directory) : undefined;
  const conversation = state && sessionId
    ? formatGoalWriterConversation(buildSessionMessageRecordsSnapshot(state, sessionId).list)
    : '';

  const subtasks = sessionId && state
    ? getAllSyncSessions()
      .filter((session) => session.parentID === sessionId)
      .filter((session) => {
        const status = getDirectoryState(session.directory)?.session_status[session.id] ?? state.session_status[session.id];
        return status?.type === 'busy' || status?.type === 'retry';
      })
      .map((session) => session.title)
    : [];

  const [projectContext, knowledge] = await Promise.all([
    project
      ? useProjectContextStore.getState().load(project)
        .then(() => useProjectContextStore.getState().getEntry(project))
        .catch(() => null)
      : Promise.resolve(null),
    sessionId && directory ? fetchSessionKnowledgeSummary(directory, sessionId) : Promise.resolve(null),
  ]);

  const formatPlan = (plan: { title: string; progress?: { done: number; total: number } }): string => (
    plan.progress && plan.progress.total > 0
      ? `${plan.title} (${plan.progress.done}/${plan.progress.total} steps done)`
      : plan.title
  );
  const planTitles = new Map<string, string>();
  for (const plan of knowledge?.plans ?? []) planTitles.set(plan.id, plan.title);
  for (const plan of projectContext?.plans ?? []) {
    // A plan whose checklist is done is no longer open work.
    if (plan.progress && plan.progress.total > 0 && plan.progress.done >= plan.progress.total) {
      planTitles.delete(plan.id);
      continue;
    }
    if (plan.pinned || planTitles.has(plan.id)) planTitles.set(plan.id, formatPlan(plan));
  }

  return {
    conversation,
    openItems: formatGoalWriterOpenItems({
      todos: (projectContext?.todos ?? []).filter((todo) => !todo.completed).map((todo) => todo.text),
      plans: [...planTitles.values()],
      queued: input.queuedMessages,
      subtasks,
    }),
  };
}
