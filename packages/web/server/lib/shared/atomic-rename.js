// Renaming a temp file over its destination fails transiently on Windows
// when another process has the destination open for reading: the rename
// throws EPERM (also seen as EACCES or EBUSY) and an atomic write that gives
// up on the first attempt loses the update. These helpers retry only those
// codes with the backoff the VS Code bridge uses for the same hazard
// (10/25/50/100 ms); every other error throws on the first attempt, and a
// rename that keeps failing surfaces its last error after the final delay.

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100];

const isTransientRenameError = (error) => Boolean(error) && TRANSIENT_RENAME_CODES.has(error.code);

const waitSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Async rename: `rename(source, destination)` is the caller's rename function (for example `fsPromises.rename`). */
export const renameWithRetry = async (rename, source, destination) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientRenameError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

/** Sync rename: waits between attempts with `Atomics.wait`, so callers stay synchronous. */
export const renameSyncWithRetry = (renameSync, source, destination) => {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientRenameError(error)) throw error;
      waitSync(delay);
    }
  }
};
