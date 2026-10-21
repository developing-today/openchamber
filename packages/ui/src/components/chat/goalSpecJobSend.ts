import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGoalSpecJobStore, type GoalSpecJob, type GoalSpecJobChoice } from '@/stores/goalSpecJobStore';
import { createMessageQueueTarget } from '@/stores/messageQueueStore';
import { createGoalArm } from '@/stores/useSessionGoalArmStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { toServerFileUrl } from './composer/attachments/filePaths';
import { buildOutgoingMessage } from './composer/submit/buildOutgoingMessage';

/**
 * Sends what the user picked on a goal writer card. The server sends a plain
 * message itself. A message with attachments or attached context is sent from
 * this window, since the server sends only text: the server hands back the
 * full message (`claim`), the session's send path delivers it with its goal
 * the way the composer sends a queued message it took back, and the server
 * hears how it went (`settle`). A failed send leaves the job open with the
 * reason, so nothing is lost.
 */
export async function sendGoalSpecJob(job: GoalSpecJob, choice: GoalSpecJobChoice): Promise<void> {
    const jobs = useGoalSpecJobStore.getState();
    if (!job.composerOnly) {
        await jobs.sendJob(job, choice);
        return;
    }

    const message = await jobs.claimJob(job, choice.kind);
    const target = createMessageQueueTarget(job.sessionId, job.directory, getRuntimeKey());
    const outgoing = buildOutgoingMessage({
        queued: [{
            text: choice.kind === 'spec' && choice.sendMode === 'goal-as-message' ? choice.spec : message.text,
            agentMention: message.agentMention,
            attachments: message.attachments,
            context: message.context,
        }],
        composerText: null,
        composerAttachments: [],
        inlineComments: [],
        syntheticTexts: [],
        references: [],
    }, {
        // Captured like a queued message: mentions and skills were resolved then.
        parseAgentMention: (text) => ({ text }),
        extractFileMentions: (text) => ({ text, attachments: [] }),
        sanitizeAttachments: (files) => (files ?? []).map((file) => (
            file.source === 'server' && file.serverPath ? { ...file, dataUrl: toServerFileUrl(file.serverPath) } : file
        )),
        collectSkillNames: () => [],
    });

    // This send carries its goal. On the composer's shared arm it would go to
    // whichever held send consumes the arm first while OpenCode starts, and
    // arming or disarming the target meanwhile would replace it.
    const goalArm = choice.kind === 'spec'
        ? createGoalArm(true, choice.spec, { settled: true, briefAgent: choice.sendMode === 'with-message' })
        : createGoalArm(job.trigger === 'armed', null, { settled: true });
    try {
        if (!target) throw new Error('The session of this goal spec has no directory');
        await useSessionUIStore.getState().sendMessage(
            outgoing.primaryText,
            job.sendConfig.providerID,
            job.sendConfig.modelID,
            job.sendConfig.agent,
            outgoing.primaryAttachments,
            outgoing.agentMentionName,
            outgoing.additionalParts.length > 0 ? outgoing.additionalParts : undefined,
            job.sendConfig.variant,
            'normal',
            { target, userInitiated: true, goalArm },
        );
    } catch (error) {
        const reason = error instanceof Error && error.message ? error.message : 'The message could not be sent';
        await jobs.settleJob(job, { outcome: null, error: reason }).catch(() => undefined);
        throw error;
    }
    await jobs.settleJob(job, choice.kind === 'spec'
        ? { outcome: { kind: 'spec', sendMode: choice.sendMode }, spec: choice.spec }
        : { outcome: { kind: 'original', withGoal: job.trigger === 'armed' } });
}
