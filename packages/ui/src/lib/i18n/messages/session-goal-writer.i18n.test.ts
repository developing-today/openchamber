import { describe, expect, test } from 'bun:test';

import { sessionGoalWriterI18n } from './session-goal-writer.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('session goal writer translations', () => {
  test('every locale has every key, translated, with placeholders intact', () => {
    const english = Object.entries(sessionGoalWriterI18n.en);
    for (const locale of locales) {
      const dictionary = new Map<string, string>(Object.entries(sessionGoalWriterI18n[locale]));
      expect([...dictionary.keys()].sort()).toEqual(english.map(([key]) => key).sort());
      for (const [key, englishText] of english) {
        const text = dictionary.get(key) ?? '';
        expect(`${locale} ${key}: ${text.trim()}`).not.toBe(`${locale} ${key}: `);
        if (locale !== 'en') {
          expect(`${locale} ${key}: ${text}`).not.toBe(`${locale} ${key}: ${englishText}`);
        }
        expect(`${locale} ${key}: ${text.includes('{model}')}`).toBe(`${locale} ${key}: ${englishText.includes('{model}')}`);
      }
    }
  });
});
