import { describe, expect, test } from 'bun:test';

import { messagingI18n } from './messaging.i18n';
import { messagingSettingsI18n } from './messaging.settings.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'zh-CN', 'zh-TW', 'uk', 'es', 'pt-BR', 'ko', 'pl', 'ja', 'tr', 'ar', 'he'] as const;
type Locale = (typeof locales)[number];

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

/** More than one word once placeholders are gone; single words such as Agent or Model may match English. */
const sentence = (text: string) => text.replace(/\{\w+\}/g, '').replace(/·/g, '').trim().includes(' ');

const checkTranslations = <Key extends string>(name: string, dictionaries: Record<Locale, Record<Key, string>>) => {
  describe(`${name} translations`, () => {
    const english = dictionaries.en;
    // SAFETY: `english` holds exactly the keys of the dictionary type it was declared with.
    const keys = Object.keys(english) as Key[];

    test('provide every key in every locale, with the same placeholders', () => {
      for (const locale of locales) {
        expect(Object.keys(dictionaries[locale]).sort()).toEqual([...keys].sort());
        for (const key of keys) {
          expect(dictionaries[locale][key]).toBeTruthy();
          expect(placeholders(dictionaries[locale][key])).toEqual(placeholders(english[key]));
        }
      }
    });

    test('translate every sentence', () => {
      for (const locale of locales) {
        if (locale === 'en') continue;
        expect(keys.filter((key) => dictionaries[locale][key] === english[key] && sentence(english[key]))).toEqual([]);
      }
    });
  });
};

checkTranslations('Messages panel', messagingI18n);
checkTranslations('Settings → Messaging', messagingSettingsI18n);
