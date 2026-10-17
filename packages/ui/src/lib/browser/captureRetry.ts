/**
 * Chromium answers capturePage() with UnknownVizError while a page has no
 * composited frame to hand over. A resize retires the current surface and the
 * replacement takes a few frames to arrive, and a tab outside the view can sit
 * in the same state. The gap is brief: issue #33 recorded two failures and a
 * success on the third manual call. A capture that waits and asks again gets
 * the frame, so this retries that one error on a short schedule. Every other
 * failure surfaces on the first attempt, because a destroyed webview or a
 * refused invoke fails the same way every time.
 */

const TRANSIENT_CAPTURE_ERROR = 'UnknownVizError';

/** Pauses between attempts, in order. Three retries span about two seconds. */
export const CAPTURE_RETRY_DELAYS_MS: readonly number[] = [250, 600, 1_200];

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientCaptureError = (message: string): boolean => message.includes(TRANSIENT_CAPTURE_ERROR);

/**
 * Runs one page capture, retrying while Chromium reports it has no frame yet.
 * A null result is a finished answer, the host has no page to capture, and it
 * passes through without a retry. When the pauses run out the last error is
 * rethrown, so the caller reports the failure it actually hit.
 */
export const capturePageWithRetry = async <T>(
  capture: () => Promise<T>,
  options: {
    readonly delaysMs?: readonly number[];
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> => {
  const delaysMs = options.delaysMs ?? CAPTURE_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await capture();
    } catch (error) {
      const delayMs = delaysMs[attempt];
      const message = error instanceof Error ? error.message : String(error);
      if (delayMs === undefined || !isTransientCaptureError(message)) throw error;
      await sleep(delayMs);
    }
  }
};
