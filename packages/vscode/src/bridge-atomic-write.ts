// Renaming a temp file over its destination fails transiently on Windows
// when another handle is reading the destination: the rename throws EPERM
// (also seen as EACCES or EBUSY) and an atomic write that gives up on the
// first attempt loses the update. These helpers retry only those codes with
// a short backoff (10/25/50/100 ms); every other error throws on the first
// attempt, and a rename that keeps failing surfaces its last error after the
// final delay. Shared by the bridge runtimes that persist JSON state
// (project-setup, settings, quota credentials, session state) so the retry
// policy lives in one place.

import fs from 'node:fs';

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];

export const renameWithRetry = async (
  source: string,
  destination: string,
  rename: (source: string, destination: string) => Promise<void> = (from, to) => fs.promises.rename(from, to),
): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      if (!(error instanceof Error) || !('code' in error) || !TRANSIENT_RENAME_CODES.has(String(error.code))) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

const waitSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export const renameSyncWithRetry = (
  source: string,
  destination: string,
  renameSync: (source: string, destination: string) => void = (from, to) => fs.renameSync(from, to),
): void => {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      if (!(error instanceof Error) || !('code' in error) || !TRANSIENT_RENAME_CODES.has(String(error.code))) throw error;
      waitSync(delay);
    }
  }
};
