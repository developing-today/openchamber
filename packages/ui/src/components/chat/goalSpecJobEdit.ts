import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGoalSpecJobStore, type GoalSpecJob } from '@/stores/goalSpecJobStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncMessages } from '@/sync/sync-refs';

/**
 * Back to edit: the job ends and its message, files and chips included, goes
 * back to a composer; an armed goal is armed again, as before the send. The
 * composer is the session's, unless the job is a new chat's: the composer
 * made that session from the draft for this message, and while nothing was
 * sent in it, the session is removed and a new-session draft takes the
 * message, so no empty session stays behind.
 */
export async function takeGoalSpecJobBack(job: GoalSpecJob): Promise<void> {
    const runtimeKey = getRuntimeKey();
    const message = await useGoalSpecJobStore.getState().editJob(job);
    const draftId = job.newSession ? await replaceEmptySessionWithDraft(job, runtimeKey) : null;
    useInputStore.getState().requestComposerEdit({
        runtimeKey,
        target: draftId === null ? { kind: 'session', sessionId: job.sessionId } : { kind: 'draft', draftId },
        content: message.content,
        attachments: message.attachments,
        context: message.context,
    });
    if (job.trigger === 'armed') useSessionGoalArmStore.getState().setArmed(true);
}

/**
 * Removes the session a new chat's job was made in and opens a new-session
 * draft in its place. Answers the draft's id, or null when the session
 * stays: it is not the one on screen, it has a message (in this window or on
 * the server), OpenCode could not say, or the removal failed. A session with
 * any message is never removed.
 */
async function replaceEmptySessionWithDraft(job: GoalSpecJob, runtimeKey: string): Promise<number | null> {
    if (useSessionUIStore.getState().currentSessionId !== job.sessionId) return null;
    if (getSyncMessages(job.sessionId, job.directory).length > 0) return null;
    let empty: boolean;
    try {
        const page = await opencodeClient.getSessionMessages(job.sessionId, { limit: 1 }, job.directory);
        empty = page.items.length === 0;
    } catch (error) {
        console.warn('[goal-spec-jobs] could not check the session before removing it:', error);
        return null;
    }
    if (!empty || runtimeKey !== getRuntimeKey()) return null;
    if (!(await useSessionUIStore.getState().deleteSession(job.sessionId, { expectedRuntimeKey: runtimeKey }))) return null;
    // A chat's directory names no project, so it opens another chat.
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: job.directory });
    return useSessionUIStore.getState().newSessionDraft.draftId;
}
