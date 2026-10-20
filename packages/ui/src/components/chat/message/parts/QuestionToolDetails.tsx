import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { ToolPart, ToolState } from '@/lib/opencode/model';
import { type QuestionAnswer, questionAnswers, questionCallKey, questionPrompts } from '@/lib/opencode/question';
import { useInputStore } from '@/sync/input-store';
import { useSessions } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useChatColumnActions, useChatSessionSelection } from '../../chatColumnSession';
import { resolveChatPromptReadOnly } from '../../chatPromptReadOnly';
import { formatQuestionAnswers, recallQuestionAnswers, rememberQuestionAnswers } from '../../questionAnswers';
import { QuestionToolDetailsView } from './QuestionToolDetailsView';

/**
 * The expanded row of an agent's `question` call: every question with all of
 * its options and their descriptions, whatever way the call ended, and the
 * answers when the call returned some. Once the call has ended, the questions
 * can be answered again from here; the answers go to the agent as a new
 * message, since the call itself is over.
 */
export function QuestionToolDetails({ part, state }: { part: ToolPart; state: ToolState }) {
    const { t } = useI18n();
    const prompts = React.useMemo(() => questionPrompts(state.input), [state.input]);
    const answers = React.useMemo(() => questionAnswers(state), [state]);
    const callKey = questionCallKey({ messageID: part.messageID, callID: part.callID });

    // Only the chat showing this call's session can send in it, and only when
    // that chat takes prompts (a subagent's session is read-only by default).
    const { sessionId, directory } = useChatSessionSelection();
    const { pinned } = useChatColumnActions();
    const sessions = useSessions(directory ?? undefined);
    const allowPromptingSubagentSessions = useUIStore((store) => store.allowPromptingSubagentSessions);
    const isMobile = useUIStore((store) => store.isMobile);
    const session = sessions.find((candidate) => candidate.id === part.sessionID);
    const ended = state.status === 'completed' || state.status === 'error';
    const canAnswer = ended
        && part.sessionID === sessionId
        && !resolveChatPromptReadOnly(session, allowPromptingSubagentSessions, false);

    const startingAnswers = React.useCallback(() => recallQuestionAnswers(callKey) ?? answers, [answers, callKey]);
    const handleKeep = React.useCallback((kept: QuestionAnswer[]) => rememberQuestionAnswers(callKey, kept), [callKey]);
    const handleSend = React.useCallback((sent: QuestionAnswer[]) => {
        rememberQuestionAnswers(callKey, sent);
        const text = formatQuestionAnswers(prompts, sent, {
            intro: t('chat.questionAnswers.message.intro'),
            unanswered: t('chat.questionAnswers.message.unanswered'),
        });
        useInputStore.getState().requestSessionSubmit({ target: pinned ? part.sessionID : null, sessionId: part.sessionID, text });
    }, [callKey, part.sessionID, pinned, prompts, t]);

    return (
        <QuestionToolDetailsView
            prompts={prompts}
            answers={answers}
            errorText={state.status === 'error' ? state.error : null}
            canAnswer={canAnswer}
            startingAnswers={startingAnswers}
            onKeep={handleKeep}
            onSend={handleSend}
            isMobile={isMobile}
        />
    );
}
