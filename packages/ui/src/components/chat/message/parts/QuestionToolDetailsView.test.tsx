import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { questionPrompts, type QuestionAnswer } from '@/lib/opencode/question';
import { QuestionAnswerForm, QuestionToolDetailsView, type QuestionToolDetailsViewProps } from './QuestionToolDetailsView';

// Static renders, as in FormMarkdown.test.tsx: question text is Markdown,
// whose renderer loads lazily through a Vite worker import that `bun test`
// cannot resolve, so a mounted tree fails once that import settles. The steps
// between these states (open, pick, send) are covered by the answer
// conversions in questionAnswers.test.ts and the send request in
// input-store.test.ts; no test here clicks through them.

const prompts = questionPrompts({
  questions: [
    {
      header: 'Mode',
      question: 'Which mode should it use?',
      multiple: false,
      options: [
        { label: 'Fast (Recommended)', description: 'One model call' },
        { label: 'Careful', description: 'A forked session that reads files' },
      ],
    },
    {
      header: 'Checks',
      question: 'Which checks run?',
      multiple: true,
      options: [
        { label: 'Types', description: 'tsc' },
        { label: 'Lint', description: 'oxlint' },
      ],
    },
  ],
});

const noop = () => undefined;

const renderView = (props: Partial<QuestionToolDetailsViewProps>) => renderToStaticMarkup(
  <I18nProvider>
    <QuestionToolDetailsView
      prompts={prompts}
      answers={null}
      errorText={null}
      canAnswer
      startingAnswers={() => null}
      onKeep={noop}
      onSend={noop}
      isMobile={false}
      {...props}
    />
  </I18nProvider>,
);

const renderForm = (starting: QuestionAnswer[] | null) => renderToStaticMarkup(
  <I18nProvider>
    <QuestionAnswerForm prompts={prompts} starting={starting} isMobile={false} onCancel={noop} onSend={noop} />
  </I18nProvider>,
);

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const buttonLabels = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) => textOf(match[1]).trim());

describe('QuestionToolDetailsView', () => {
  test('a dismissed question still shows every question, option and description, and why it went unanswered', () => {
    const html = renderView({ errorText: 'The user dismissed this question' });
    const text = textOf(html);

    for (const expected of ['Which mode should it use?', 'Fast', 'recommended', 'One model call', 'Careful', 'A forked session that reads files', 'Which checks run?', 'Types', 'tsc', 'Lint', 'oxlint']) {
      expect(text).toContain(expected);
    }
    expect(text).toContain('Not answered · The user dismissed this question');
    expect(buttonLabels(html)).toEqual(['Answer']);
  });

  test('an answered call marks what was chosen, shows a typed answer, and offers to answer again', () => {
    const html = renderView({ answers: [['Careful'], ['Types', 'also run the e2e suite']] });
    const text = textOf(html);

    expect(html.match(/class="sr-only"/g)?.length).toBe(2);
    expect(text).toContain('Your answer');
    expect(text).toContain('also run the e2e suite');
    expect(text).not.toContain('Not answered');
    expect(buttonLabels(html)).toEqual(['Answer again']);
  });

  test('a question the call left without an answer says so', () => {
    const text = textOf(renderView({ answers: [['Careful'], []] }));

    expect(text).toContain('Not answered');
  });

  test('without a chat that can send in its session there is no way to answer', () => {
    const html = renderView({ errorText: 'The user dismissed this question', canAnswer: false });

    expect(textOf(html)).toContain('Which mode should it use?');
    expect(buttonLabels(html)).toEqual([]);
  });

  test('the form opens on the answers given before', () => {
    const html = renderForm([['Careful'], ['Lint']]);
    // The control of each option row comes right before its label.
    const checkedState = (label: string) => {
      const at = html.indexOf(`>${label}<`);
      if (at < 0) throw new Error(`No option "${label}" in: ${textOf(html)}`);
      return [...html.slice(0, at).matchAll(/aria-checked="(true|false)"/g)].at(-1)?.[1];
    };

    expect(checkedState('Fast')).toBe('false');
    expect(checkedState('Careful')).toBe('true');
    expect(checkedState('Types')).toBe('false');
    expect(checkedState('Lint')).toBe('true');
    expect(/<button[^>]*disabled=""[^>]*>[\s\S]{0,200}Send answers/.test(html)).toBe(false);
  });

  test('the form with nothing answered cannot send yet', () => {
    expect(/<button[^>]*disabled=""[^>]*>[\s\S]{0,200}Send answers/.test(renderForm(null))).toBe(true);
  });
});
