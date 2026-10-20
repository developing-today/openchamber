import type { FormField } from '@opencode/client';
import { questionAnswerOf, type QuestionAnswer, type QuestionPrompt } from '@/lib/opencode/question';
import { type FormValues, buildFormAnswer, initialFormValues, isAnswerableField, valueOf } from './formCardState';

/**
 * Answers to an agent's `question` call that outlive the call: the dock
 * records them as the user picks, so a question dismissed, stopped or failed
 * can be answered again from its transcript row starting where the user was.
 * Keyed by `questionCallKey`; memory only, like the dock's own drafts.
 */
const rememberedAnswers = new Map<string, QuestionAnswer[]>();
const MAX_REMEMBERED_ANSWERS = 50;

export const rememberQuestionAnswers = (callKey: string, answers: QuestionAnswer[]): void => {
    rememberedAnswers.delete(callKey);
    rememberedAnswers.set(callKey, answers);
    if (rememberedAnswers.size > MAX_REMEMBERED_ANSWERS) {
        const oldest = rememberedAnswers.keys().next().value;
        if (oldest !== undefined) rememberedAnswers.delete(oldest);
    }
};

export const recallQuestionAnswers = (callKey: string): QuestionAnswer[] | null => rememberedAnswers.get(callKey) ?? null;

/** Each question's answer as OpenCode's tool would report it, from the form's current values. */
export function answersFromFormValues(fields: readonly FormField[], values: FormValues): QuestionAnswer[] {
    const reply = buildFormAnswer(fields, values);
    return fields.map((field) => questionAnswerOf(reply[field.key]));
}

/**
 * Form values that show these answers: a chosen option is selected again,
 * and text that names no option goes back into the field's own-answer box.
 */
export function formValuesFromAnswers(fields: readonly FormField[], answers: readonly QuestionAnswer[]): FormValues {
    const values = initialFormValues(fields);
    fields.forEach((field, index) => {
        const answer = answers[index];
        if (!answer || answer.length === 0 || !isAnswerableField(field)) return;
        if (field.type !== 'string' && field.type !== 'multiselect') return;
        const optionValues = new Set((field.options ?? []).map((option) => option.value));
        const chosen = answer.filter((entry) => optionValues.has(entry));
        const typed = answer.find((entry) => !optionValues.has(entry)) ?? '';
        const value = valueOf(values, field.key);
        if (field.type === 'multiselect') {
            values[field.key] = { ...value, selected: chosen, text: typed, custom: typed.length > 0 };
            return;
        }
        values[field.key] = typed.length > 0
            ? { ...value, selected: [], text: typed, custom: true }
            : { ...value, selected: chosen.slice(0, 1), text: '', custom: false };
    });
    return values;
}

export type QuestionAnswerMessageLabels = {
    /** The line that opens the message, in the user's language. */
    intro: string;
    /** Stands in for a question left without an answer. */
    unanswered: string;
};

/**
 * The message that carries answers given after the call ended, in the
 * `"question"="answer"` shape OpenCode's tool result uses, so the agent reads
 * them the way it reads an answer to its call.
 */
export function formatQuestionAnswers(
    prompts: readonly QuestionPrompt[],
    answers: readonly QuestionAnswer[],
    labels: QuestionAnswerMessageLabels,
): string {
    const lines = prompts.map((prompt, index) => {
        const answer = answers[index];
        const text = answer && answer.length > 0 ? answer.join(', ') : labels.unanswered;
        return `- "${prompt.question}"="${text}"`;
    });
    return [labels.intro, ...lines].join('\n');
}
