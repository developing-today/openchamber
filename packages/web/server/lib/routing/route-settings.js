/**
 * Settings for the rules interpreter: which stages run and the thresholds
 * behind learning and wait estimates. Stored in OpenChamber's own settings
 * directory, never in the OpenCode config. Every value has a default that works,
 * so the file only needs to exist once the user changes something.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renameSyncWithRetry } from '../shared/atomic-rename.js';
import { DEFAULT_TOGGLES } from './route-interpreter.js';

export const DEFAULT_SETTINGS = {
  stages: { ...DEFAULT_TOGGLES },
  learnAfter: 3,
  waitPercentile: 25,
  waitMinSamples: 5,
};

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
};

export const normalizeSettings = (input = {}) => ({
  stages: {
    keywords: input.stages?.keywords !== false,
    local: input.stages?.local !== false,
    external: input.stages?.external !== false,
  },
  learnAfter: clamp(input.learnAfter, 1, 20, DEFAULT_SETTINGS.learnAfter),
  waitPercentile: clamp(input.waitPercentile, 5, 75, DEFAULT_SETTINGS.waitPercentile),
  waitMinSamples: clamp(input.waitMinSamples, 1, 100, DEFAULT_SETTINGS.waitMinSamples),
});

const resolveSettingsFile = (env = process.env) => {
  const dir = env.OPENCHAMBER_DATA_DIR?.trim()
    ? path.resolve(env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  return path.join(dir, 'route-settings.json');
};

export const createSettingsStore = ({ file = resolveSettingsFile() } = {}) => {
  // A torn or otherwise unparseable settings file is user data, not the
  // defaults: move its bytes aside before any later write can overwrite
  // them, and name the preserved copy so the loss is recoverable.
  // The parse/normalize error itself is never logged: JSON.parse messages
  // quote the file content, which is user data.
  const preserveCorruptFile = () => {
    // The suffix must be collision-proof: a timestamp alone can repeat, and
    // rename would silently replace an earlier preserved copy.
    let preservedFile = null;
    for (let attempt = 0; attempt < 10 && preservedFile === null; attempt += 1) {
      const candidate = `${file}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      if (!fs.existsSync(candidate)) preservedFile = candidate;
    }
    if (preservedFile === null) {
      console.warn('Failed to read route settings file: the file could not be parsed');
      console.warn('Failed to preserve the unreadable route settings file: every preserved-file name collided');
      return false;
    }
    try {
      renameSyncWithRetry((from, to) => fs.renameSync(from, to), file, preservedFile);
      console.warn(`Failed to read route settings file: preserved the unreadable file at ${preservedFile}`);
      return true;
    } catch {
      console.warn('Failed to read route settings file: the file could not be parsed');
      console.warn(`Failed to preserve the unreadable route settings file at ${preservedFile}`);
      return false;
    }
  };

  // 'none' when no corrupt file is in the way, 'preserved' when one was moved
  // aside, 'failed' when one is present but could not be preserved — a write
  // must not overwrite an unpreserved corrupt file. Validity is the read
  // path's validity: JSON that parses but cannot be normalized (e.g. `null`)
  // is just as corrupt here as unparseable JSON.
  const preserveCorruptFileIfPresent = () => {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      // Only a missing file is 'none'. Any other read failure (EACCES,
      // EISDIR, ...) leaves an existing file whose bytes were neither
      // parsed nor preserved: report 'failed' so the write refuses rather
      // than renaming a new file over them.
      return error?.code === 'ENOENT' ? 'none' : 'failed';
    }
    try {
      normalizeSettings(JSON.parse(raw));
      return 'none';
    } catch {
      return preserveCorruptFile() ? 'preserved' : 'failed';
    }
  };

  const read = () => {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('Failed to read route settings file:', error);
      }
      return normalizeSettings({});
    }
    try {
      return normalizeSettings(JSON.parse(raw));
    } catch {
      preserveCorruptFile();
      return normalizeSettings({});
    }
  };

  const write = (input) => {
    const next = normalizeSettings(input);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (preserveCorruptFileIfPresent() === 'failed') {
      throw new Error(`Refusing to overwrite the unreadable route settings file at ${file}: it could not be preserved`);
    }
    const temporaryFile = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temporaryFile, JSON.stringify(next, null, 2));
      renameSyncWithRetry((from, to) => fs.renameSync(from, to), temporaryFile, file);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryFile);
      } catch {
        // The temp file may never have been created; the write error stands.
      }
      throw error;
    }
    return next;
  };

  return { read, write };
};
