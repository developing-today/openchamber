import { describe, expect, it } from 'vitest';
import { transformModelData, transformQuotaBucket } from './transforms.js';

describe('Google transforms', () => {
  it('keeps the reported reset without inventing a window duration for either response shape', () => {
    const resetTime = '2026-10-08T14:29:35Z';
    const bucket = transformQuotaBucket({ modelId: 'test', remainingFraction: 0.5, resetTime }, 'google');
    const model = transformModelData('test', { quotaInfo: { remainingFraction: 0.5, resetTime } }, 'google');

    for (const result of [bucket, model]) {
      const windows = result['google/test'].windows;
      expect(Object.keys(windows)).toEqual(['Antigravity Code Assist (per-model)']);
      expect(windows['Antigravity Code Assist (per-model)']).toMatchObject({
        usedPercent: 50, windowSeconds: null, resetAt: Date.parse(resetTime)
      });
    }
  });

  it.each([
    [-0.5, 100],
    [0, 100],
    [1, 0],
    [1.5, 0]
  ])('transformQuotaBucket clamps usedPercent to [0, 100] for remainingFraction %s', (remainingFraction, expectedUsedPercent) => {
    const result = transformQuotaBucket(
      { modelId: 'gemini-2.5-pro', remainingFraction, resetTime: '2026-10-08T14:29:35Z' },
      'google'
    );

    expect(result['google/gemini-2.5-pro'].windows['Antigravity Code Assist (per-model)'].usedPercent).toBe(expectedUsedPercent);
  });

  it.each([
    [-0.5, 100],
    [0, 100],
    [1, 0],
    [1.5, 0]
  ])('transformModelData clamps usedPercent to [0, 100] for remainingFraction %s', (remainingFraction, expectedUsedPercent) => {
    const result = transformModelData(
      'gemini-2.5-pro',
      { quotaInfo: { remainingFraction, resetTime: '2026-10-08T14:29:35Z' } },
      'google'
    );

    expect(result['google/gemini-2.5-pro'].windows['Antigravity Code Assist (per-model)'].usedPercent).toBe(expectedUsedPercent);
  });

  it('transformModelData returns the parsed resetAt for a valid resetTime', () => {
    const result = transformModelData(
      'gemini-2.5-pro',
      { quotaInfo: { remainingFraction: 0.5, resetTime: '2026-10-08T14:29:35Z' } },
      'google'
    );

    expect(result['google/gemini-2.5-pro'].windows['Antigravity Code Assist (per-model)'].resetAt).toBe(Date.parse('2026-10-08T14:29:35Z'));
  });

  it('transformModelData returns resetAt null for an unparseable resetTime', () => {
    const result = transformModelData(
      'gemini-2.5-pro',
      { quotaInfo: { remainingFraction: 0.5, resetTime: 'not-a-date' } },
      'google'
    );

    expect(result['google/gemini-2.5-pro'].windows['Antigravity Code Assist (per-model)'].resetAt).toBeNull();
  });

  it.each([
    ['missing resetTime', { quotaInfo: { remainingFraction: 0.5 } }],
    ['missing quotaInfo', {}],
    ['missing modelData', undefined]
  ])('transformModelData returns resetAt null for %s', (_label, modelData) => {
    const result = transformModelData('gemini-2.5-pro', modelData, 'google');

    expect(result['google/gemini-2.5-pro'].windows['Antigravity Code Assist (per-model)'].resetAt).toBeNull();
  });

  it('transformModelData does not double-prefix an already scoped model name', () => {
    const result = transformModelData(
      'google/gemini-2.5-pro',
      { quotaInfo: { remainingFraction: 0.5, resetTime: '2026-10-08T14:29:35Z' } },
      'google'
    );

    expect(Object.keys(result)).toEqual(['google/gemini-2.5-pro']);
  });

  it.each([
    ['2026-10-08T14:29:35Z', Date.parse('2026-10-08T14:29:35Z')],
    ['not-a-date', null],
    [undefined, null]
  ])('transformQuotaBucket returns resetAt %s -> %s', (resetTime, expectedResetAt) => {
    const result = transformQuotaBucket(
      { modelId: 'gemini-2.5-pro', remainingFraction: 0.5, resetTime },
      'google'
    );

    expect(result['google/gemini-2.5-pro'].windows['Antigravity Code Assist (per-model)'].resetAt).toBe(expectedResetAt);
  });
});
