import { renameWithRetry } from '../shared/atomic-rename.js';

const FILE_VERSION = 1;
const MAX_PROMPT_TEXT_LENGTH = 200_000;
const PROMPT_ID_PATTERN = /^[a-z0-9._-]{1,160}$/;
const isVisiblePromptID = (id) => typeof id === 'string' && id.endsWith('.visible');

const hasOwn = (input, key) => Object.prototype.hasOwnProperty.call(input, key);

const sanitizeOverrides = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PROMPT_ID_PATTERN.test(key) || typeof entry !== 'string') {
      continue;
    }
    next[key] = entry;
  }
  return next;
};

export const createMagicPromptRuntime = (dependencies) => {
  const {
    fsPromises,
    path,
    filePath,
  } = dependencies;

  let writeLock = Promise.resolve();

  const enqueueLocked = (fn) => {
    writeLock = writeLock.then(fn, fn);
    return writeLock;
  };

  const emptyState = () => ({ version: FILE_VERSION, overrides: {} });

  const stateFromParsed = (parsed) => ({
    version: FILE_VERSION,
    overrides: sanitizeOverrides(parsed?.overrides),
  });

  const isEnoent = (error) => Boolean(error && typeof error === 'object' && error.code === 'ENOENT');

  // A torn or otherwise unparseable file is user data, not an empty
  // store: move its bytes aside before any later write can overwrite
  // them, and name the preserved copy so the loss is recoverable. Only
  // call this serialized with writes (or re-validated under the lock):
  // the file at filePath may have been replaced by a valid write since
  // the bytes that failed to parse were read.
  const preserveCorruptFile = async (error) => {
    const preservedPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      await renameWithRetry((from, to) => fsPromises.rename(from, to), filePath, preservedPath);
      console.warn(`Failed to read magic prompts file: preserved the unreadable file at ${preservedPath}:`, error);
      return true;
    } catch (preserveError) {
      console.warn('Failed to read magic prompts file:', error);
      console.warn(`Failed to preserve the unreadable magic prompts file at ${preservedPath}:`, preserveError);
      return false;
    }
  };

  const readRawFile = async () => {
    try {
      return { raw: await fsPromises.readFile(filePath, 'utf8') };
    } catch (error) {
      if (!isEnoent(error)) {
        console.warn('Failed to read magic prompts file:', error);
      }
      return { missing: true };
    }
  };

  // Read + parse, preserving a corrupt file inline. Only for callers
  // already serialized with writes (persist): an unlocked caller must
  // use readPromptState, which re-validates under the lock.
  const readPromptStateLocked = async () => {
    const { raw, missing } = await readRawFile();
    if (missing) {
      return emptyState();
    }
    try {
      return stateFromParsed(JSON.parse(raw));
    } catch (error) {
      // A mutation must never overwrite bytes whose preservation just
      // failed: they are the only copy of the user's overrides. Abort
      // instead; the caller can retry once the file is movable.
      const preserved = await preserveCorruptFile(error);
      if (!preserved) {
        throw new Error('Failed to preserve the unreadable magic prompts file; refusing to overwrite it', { cause: error });
      }
      return emptyState();
    }
  };

  const readPromptState = async () => {
    const { raw, missing } = await readRawFile();
    if (missing) {
      return emptyState();
    }
    try {
      return stateFromParsed(JSON.parse(raw));
    } catch (error) {
      // The bytes above are stale the moment the read returns: a
      // concurrent write may already have preserved the corrupt file
      // and saved valid state in its place, and renaming filePath now
      // would move that saved state aside. Re-validate under the write
      // lock before preserving anything; if a write landed in between,
      // its state is the answer, not an empty store.
      return enqueueLocked(async () => {
        const current = await readRawFile();
        if (current.missing) {
          return emptyState();
        }
        try {
          return stateFromParsed(JSON.parse(current.raw));
        } catch {
          await preserveCorruptFile(error);
          return emptyState();
        }
      });
    }
  };

  const writePromptState = async (state) => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      await fsPromises.writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8');
      await renameWithRetry((from, to) => fsPromises.rename(from, to), tempPath, filePath);
    } catch (error) {
      try {
        if (typeof fsPromises.unlink === 'function') {
          await fsPromises.unlink(tempPath);
        }
      } catch {
        // The write/rename error is the one the caller needs; a failed
        // temp cleanup must not mask it.
      }
      throw error;
    }
  };

  const persist = async (mutator) => enqueueLocked(async () => {
    const current = await readPromptStateLocked();
    const next = await mutator(current);
    await writePromptState(next);
    return next;
  });

  const setOverride = async (id, text) => {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if (!PROMPT_ID_PATTERN.test(normalizedId)) {
      throw new Error('Invalid prompt id');
    }
    if (typeof text !== 'string') {
      throw new Error('Prompt text must be a string');
    }
    if (isVisiblePromptID(normalizedId) && text.trim().length === 0) {
      throw new Error('Visible prompt text cannot be empty');
    }
    if (text.length > MAX_PROMPT_TEXT_LENGTH) {
      throw new Error('Prompt text is too long');
    }

    return persist(async (state) => {
      const nextOverrides = { ...state.overrides, [normalizedId]: text };
      return {
        version: FILE_VERSION,
        overrides: nextOverrides,
      };
    });
  };

  const resetOverride = async (id) => {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if (!PROMPT_ID_PATTERN.test(normalizedId)) {
      throw new Error('Invalid prompt id');
    }

    return persist(async (state) => {
      if (!hasOwn(state.overrides, normalizedId)) {
        return state;
      }
      const nextOverrides = { ...state.overrides };
      delete nextOverrides[normalizedId];
      return {
        version: FILE_VERSION,
        overrides: nextOverrides,
      };
    });
  };

  const resetAllOverrides = async () => {
    return persist(async () => ({ version: FILE_VERSION, overrides: {} }));
  };

  return {
    readPromptState,
    setOverride,
    resetOverride,
    resetAllOverrides,
  };
};
