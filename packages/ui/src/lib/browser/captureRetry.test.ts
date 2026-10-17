import { describe, expect, test } from 'bun:test';

import { CAPTURE_RETRY_DELAYS_MS, capturePageWithRetry } from './captureRetry';

const VIZ_ERROR = "Error invoking remote method 'openchamber:invoke': Error: UnknownVizError";

/** A sleep that records the pauses it was asked for and returns at once. */
const recordingSleep = () => {
  const pauses: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    pauses.push(ms);
  };
  return { pauses, sleep };
};

describe('capture retry', () => {
  test('a capture that succeeds at once is returned without a pause', async () => {
    const { pauses, sleep } = recordingSleep();
    let calls = 0;
    const result = await capturePageWithRetry(async () => {
      calls += 1;
      return 'frame';
    }, { sleep });

    expect(result).toBe('frame');
    expect(calls).toBe(1);
    expect(pauses).toEqual([]);
  });

  test('the sequence from issue #33, two UnknownVizErrors then a frame, succeeds', async () => {
    const { pauses, sleep } = recordingSleep();
    let calls = 0;
    const result = await capturePageWithRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error(VIZ_ERROR);
      return 'frame';
    }, { sleep });

    expect(result).toBe('frame');
    expect(calls).toBe(3);
    expect(pauses).toEqual([CAPTURE_RETRY_DELAYS_MS[0], CAPTURE_RETRY_DELAYS_MS[1]]);
  });

  test('a failure with any other error surfaces on the first attempt', async () => {
    const { pauses, sleep } = recordingSleep();
    let calls = 0;
    const attempt = capturePageWithRetry(async () => {
      calls += 1;
      throw new Error('Browser view is not available');
    }, { sleep });

    await expect(attempt).rejects.toThrow('Browser view is not available');
    expect(calls).toBe(1);
    expect(pauses).toEqual([]);
  });

  test('when the pauses run out the last UnknownVizError is rethrown', async () => {
    const { pauses, sleep } = recordingSleep();
    let calls = 0;
    const attempt = capturePageWithRetry(async () => {
      calls += 1;
      throw new Error(VIZ_ERROR);
    }, { delaysMs: [10, 20], sleep });

    await expect(attempt).rejects.toThrow('UnknownVizError');
    expect(calls).toBe(3);
    expect(pauses).toEqual([10, 20]);
  });

  test('a null result is a finished answer and passes through without a retry', async () => {
    const { pauses, sleep } = recordingSleep();
    let calls = 0;
    const result = await capturePageWithRetry(async () => {
      calls += 1;
      return null;
    }, { sleep });

    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(pauses).toEqual([]);
  });
});
