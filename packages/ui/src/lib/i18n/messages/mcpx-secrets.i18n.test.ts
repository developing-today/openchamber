import { describe, expect, test } from 'bun:test';

import { mcpxSecretsI18n } from './mcpx-secrets.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('mcpx secret prompt translations', () => {
  test('provides every key in every supported locale, translated, with the same placeholders', () => {
    const english = mcpxSecretsI18n.en;
    // SAFETY: `english` is a const literal, so its own keys are exactly `keyof typeof english`.
    const keys = Object.keys(english) as Array<keyof typeof english>;
    for (const locale of locales) {
      expect(Object.keys(mcpxSecretsI18n[locale]).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        const value = mcpxSecretsI18n[locale][key];
        expect(value).toBeTruthy();
        expect(placeholders(value)).toEqual(placeholders(english[key]));
        if (locale !== 'en') expect(value).not.toBe(english[key]);
      }
    }
  });
});
