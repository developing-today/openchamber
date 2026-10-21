import React from 'react';
import type { Message } from '@/lib/opencode/model';
import { useGoalSpecJobStore, type GoalSpecJob } from '@/stores/goalSpecJobStore';
import { useSessionMessagesSelector } from '@/sync/sync-context';

/**
 * Whether a user message came after the one a sent goal writer job sent. The
 * transcript is in time order. When the job's own message is not in it (older
 * than the loaded pages, not delivered yet, or not named by a server from
 * before the field), a user message that arrived after the send counts.
 */
export function hasUserMessageAfterSentJob(
    messages: readonly Message[],
    job: Pick<GoalSpecJob, 'messageId' | 'updatedAt'>,
): boolean {
    const ownIndex = job.messageId ? messages.findIndex((message) => message.id === job.messageId) : -1;
    if (ownIndex === -1) {
        return messages.some((message) => message.role === 'user' && message.time.created > job.updatedAt);
    }
    for (let index = ownIndex + 1; index < messages.length; index += 1) {
        if (messages[index].role === 'user') return true;
    }
    return false;
}

/**
 * Whether a session's sent goal writer card has a user message after it. The
 * card is the transcript's last row, so after the user's next message it would
 * sit under turns it has nothing to do with.
 */
export function useSentGoalSpecJobOvertaken(sessionId: string, directory: string | undefined): boolean {
    const sent = useGoalSpecJobStore((state) => {
        const job = state.jobs[sessionId];
        return job?.status === 'sent' ? job : null;
    });
    const select = React.useCallback(
        (messages: Message[]) => sent !== null && hasUserMessageAfterSentJob(messages, sent),
        [sent],
    );
    return useSessionMessagesSelector(sessionId, directory, select);
}
