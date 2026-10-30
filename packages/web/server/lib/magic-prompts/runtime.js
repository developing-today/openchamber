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

  const readPromptState = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return { version: FILE_VERSION, overrides: {} };
      }
      console.warn('Failed to read magic prompts file:', error);
      return { version: FILE_VERSION, overrides: {} };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // A torn or otherwise unparseable file is user data, not an empty
      // store: move its bytes aside before any later write can overwrite
      // them, and name the preserved copy so the loss is recoverable.
      const preservedPath = `${filePath}.corrupt-${Date.now()}`;
      try {
        await fsPromises.rename(filePath, preservedPath);
        console.warn(`Failed to read magic prompts file: preserved the unreadable file at ${preservedPath}:`, error);
      } catch (preserveError) {
        console.warn('Failed to read magic prompts file:', error);
        console.warn(`Failed to preserve the unreadable magic prompts file at ${preservedPath}:`, preserveError);
      }
      return { version: FILE_VERSION, overrides: {} };
    }
    const overrides = sanitizeOverrides(parsed?.overrides);
    return {
      version: FILE_VERSION,
      overrides,
    };
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

  const persist = async (mutator) => {
    const run = async () => {
      const current = await readPromptState();
      const next = await mutator(current);
      await writePromptState(next);
      return next;
    };
    writeLock = writeLock.then(run, run);
    return writeLock;
  };

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
