import { describe, expect, it } from 'vitest';
import { transformModelData, transformQuotaBucket } from './transforms.js';

describe('Google transforms', () => {
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

    expect(result['google/gemini-2.5-pro'].windows.daily.usedPercent).toBe(expectedUsedPercent);
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

    expect(result['google/gemini-2.5-pro'].windows.daily.usedPercent).toBe(expectedUsedPercent);
  });
});
