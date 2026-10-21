import { describe, expect, test } from 'bun:test';

import { PLAN_TIERS } from '../../routing/plansApi';
import { routingI18n } from './routing.i18n';

const locales = ['en', 'nl', 'uk', 'de', 'fr', 'es', 'ja', 'ko', 'pl', 'pt-BR', 'tr', 'zh-CN', 'zh-TW', 'ar', 'he'] as const;

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('routing translations', () => {
  const english = routingI18n.en;
  // SAFETY: `english` is a const literal, so its own keys are exactly `keyof typeof english`.
  const keys = Object.keys(english) as Array<keyof typeof english>;

  test('provide every key in every locale, with the same placeholders', () => {
    expect(Object.keys(routingI18n).sort()).toEqual([...locales].sort());
    for (const locale of locales) {
      expect(Object.keys(routingI18n[locale]).sort()).toEqual([...keys].sort());
      for (const key of keys) expect(placeholders(routingI18n[locale][key])).toEqual(placeholders(english[key]));
    }
  });

  // Pools and review settings live in opencode.json or opencode.jsonc, whichever the user has
  // (packages/web/server/lib/opencode/shared.js, getPrimaryUserConfigPath), so no text names one.
  test('never send the user to opencode.json by name', () => {
    for (const locale of locales) {
      expect(keys.filter((key) => routingI18n[locale][key].includes('opencode.json'))).toEqual([]);
    }
  });

  test('name the cost tiers the plan store accepts', () => {
    const description = english['settings.routing.plans.models.description'].toLowerCase();
    for (const tier of PLAN_TIERS) expect(description).toContain(tier);
  });
});
