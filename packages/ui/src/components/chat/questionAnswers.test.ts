import { describe, expect, test } from 'bun:test';
import { questionFormFields, questionPrompts } from '@/lib/opencode/question';
import {
    answersFromFormValues,
    formValuesFromAnswers,
    formatQuestionAnswers,
    recallQuestionAnswers,
    rememberQuestionAnswers,
} from './questionAnswers';

const prompts = questionPrompts({
    questions: [
        { header: 'Mode', question: 'Which mode?', multiple: false, options: [{ label: 'Fast', description: '' }, { label: 'Careful', description: '' }] },
        { header: 'Checks', question: 'Which checks?', multiple: true, options: [{ label: 'Types', description: '' }, { label: 'Lint', description: '' }] },
    ],
});
const fields = questionFormFields(prompts);

describe('question answers', () => {
    test('answers loaded into the form come back out unchanged', () => {
        const cases = [
            [['Careful'], ['Types', 'Lint']],
            [['my own mode'], ['Lint', 'also run the e2e suite']],
            [[], ['Types']],
            [[], []],
        ];
        for (const answers of cases) {
            expect(answersFromFormValues(fields, formValuesFromAnswers(fields, answers))).toEqual(answers);
        }
    });

    test('a typed answer goes back into the own-answer box, a chosen one selects its option', () => {
        const values = formValuesFromAnswers(fields, [['my own mode'], ['Lint']]);

        expect(values.q0).toMatchObject({ selected: [], text: 'my own mode', custom: true });
        expect(values.q1).toMatchObject({ selected: ['Lint'], text: '', custom: false });
    });

    test('the message pairs each question with its answer, and marks the ones left open', () => {
        const text = formatQuestionAnswers(prompts, [['Careful'], []], { intro: 'My answers:', unanswered: 'Unanswered' });

        expect(text).toBe('My answers:\n- "Which mode?"="Careful"\n- "Which checks?"="Unanswered"');
        expect(formatQuestionAnswers(prompts, [['Fast'], ['Types', 'Lint']], { intro: 'My answers:', unanswered: '-' }))
            .toBe('My answers:\n- "Which mode?"="Fast"\n- "Which checks?"="Types, Lint"');
    });

    test('remembered answers are found by their call, the newest kept when the list is full', () => {
        rememberQuestionAnswers('msg_0:call_0', [['Fast']]);
        rememberQuestionAnswers('msg_0:call_0', [['Careful']]);
        expect(recallQuestionAnswers('msg_0:call_0')).toEqual([['Careful']]);
        expect(recallQuestionAnswers('msg_0:unknown')).toBeNull();

        for (let index = 1; index <= 50; index += 1) rememberQuestionAnswers(`msg_${index}:call`, [[String(index)]]);
        expect(recallQuestionAnswers('msg_0:call_0')).toBeNull();
        expect(recallQuestionAnswers('msg_50:call')).toEqual([['50']]);
        expect(recallQuestionAnswers('msg_1:call')).toEqual([['1']]);
    });
});
