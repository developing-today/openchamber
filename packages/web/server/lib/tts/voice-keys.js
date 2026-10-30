import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { renameSyncWithRetry } from '../shared/atomic-rename.js';

/**
 * API keys for voice services the user typed in Settings: OpenAI read-aloud,
 * a custom OpenAI-compatible speech server, and a custom transcription
 * server. They live here, mode 0600, like every other credential the server
 * keeps; browsers hold only whether each one is set. Routes fill a request's
 * key from here, so a key never travels with a request from the UI.
 */
const VOICE_KEY_KINDS = ['openai', 'openaiCompatible', 'stt'];

const storedKey = z.string().trim().min(1).max(1024);
const storedKeysSchema = z.object({
  openai: storedKey.optional().catch(undefined),
  openaiCompatible: storedKey.optional().catch(undefined),
  stt: storedKey.optional().catch(undefined),
});
// A string sets the key, null or '' removes it, an absent kind stays as is.
const patchValue = z.union([z.literal(''), z.null(), storedKey]);
const patchSchema = z.object({
  openai: patchValue.optional(),
  openaiCompatible: patchValue.optional(),
  stt: patchValue.optional(),
}).strict();

const resolveDataDir = () => (process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber'));

const voiceKeysPath = () => path.join(resolveDataDir(), 'voice-keys.json');

const readStoredKeys = () => {
  let raw;
  try {
    raw = fs.readFileSync(voiceKeysPath(), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[voice] voice-keys.json is unreadable:', error?.message ?? error);
    }
    return {};
  }
  try {
    return storedKeysSchema.parse(JSON.parse(raw));
  } catch (error) {
    console.warn('[voice] voice-keys.json is malformed:', error?.message ?? error);
    return {};
  }
};

// The update path cannot treat a malformed file as an empty store the way
// a read can: it rewrites the file from what it read, so the stored keys
// would be erased for good. Preserve the malformed bytes to a .corrupt-
// sibling first (the parse error itself is never logged: it quotes the
// file, and the file holds API keys), and fail closed when the file cannot
// even be read — an update that cannot see the current keys must not
// replace them.
const preserveMalformedVoiceKeysFile = (filePath) => {
  let preservedPath = null;
  for (let attempt = 0; attempt < 10 && preservedPath === null; attempt += 1) {
    const candidate = `${filePath}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    if (!fs.existsSync(candidate)) preservedPath = candidate;
  }
  if (preservedPath === null) return false;
  try {
    renameSyncWithRetry((from, to) => fs.renameSync(from, to), filePath, preservedPath);
    console.warn(`[voice] voice-keys.json is malformed: preserved the unreadable file at ${preservedPath}`);
    return true;
  } catch {
    return false;
  }
};

const readStoredKeysForUpdate = (filePath) => {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  try {
    return storedKeysSchema.parse(JSON.parse(raw));
  } catch {
    if (!preserveMalformedVoiceKeysFile(filePath)) {
      throw new Error(`Refusing to overwrite the malformed voice keys file at ${filePath}: it could not be preserved`);
    }
    return {};
  }
};

/** The stored key for one kind, or undefined. */
export const readVoiceKey = (kind) => readStoredKeys()[kind];

/** Which kinds have a key; never the keys themselves. */
export const describeVoiceKeys = () => {
  const keys = readStoredKeys();
  return Object.fromEntries(VOICE_KEY_KINDS.map((kind) => [kind, Boolean(keys[kind])]));
};

/**
 * Apply a patch from `/api/voice/keys` and answer the new state. Throws on a
 * malformed patch before anything is written.
 */
export const updateVoiceKeys = (body) => {
  const patch = patchSchema.parse(body);
  const filePath = voiceKeysPath();
  const next = { ...readStoredKeysForUpdate(filePath) };
  for (const kind of VOICE_KEY_KINDS) {
    if (!(kind in patch)) continue;
    const value = patch[kind];
    if (value) next[kind] = value;
    else delete next[kind];
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSyncWithRetry((from, to) => fs.renameSync(from, to), temporaryPath, filePath);
  return describeVoiceKeys();
};
