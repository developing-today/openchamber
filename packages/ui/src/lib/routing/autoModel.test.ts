import { describe, expect, test } from 'bun:test';

import { AUTO_MODEL_ID, AUTO_PROVIDER_ID, isAutoModel } from './autoModel';

describe('isAutoModel', () => {
  test('matches the Auto sentinel and nothing else', () => {
    expect(isAutoModel(AUTO_PROVIDER_ID, AUTO_MODEL_ID)).toBe(true);
    expect(isAutoModel('openchamber', 'auto')).toBe(true);
    expect(isAutoModel('openai', 'auto')).toBe(false);
    expect(isAutoModel('openchamber', 'gpt-6-luna')).toBe(false);
    expect(isAutoModel(null, undefined)).toBe(false);
  });
});
