/**
 * Overrides that OpenCode reads at routing time, and the feedback log the
 * interpreter learns from. Both live beside each other in OpenCode's data
 * directory, the same place OpenCode resolves `route-overrides.json`, so the
 * file format here must stay in step with `ModelRouteOverrides.parse`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renameSyncWithRetry } from '../shared/atomic-rename.js';

const ACTIONS = ['avoid', 'prefer', 'allow-over-budget'];

export const resolveOpenCodeDataDir = (env = process.env) => {
  const base = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode');
};

const strings = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];

const parseOverride = (item) => {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id !== 'string' || !ACTIONS.includes(item.action)) return null;
  if (typeof item.until !== 'number' || !Number.isFinite(item.until)) return null;
  const providers = strings(item.providers);
  const models = strings(item.models);
  if (providers.length === 0 && models.length === 0) return null;
  const factor = typeof item.factor === 'number' && Number.isFinite(item.factor) && item.factor > 0 ? item.factor : undefined;
  return {
    id: item.id,
    action: item.action,
    providers,
    models,
    routes: strings(item.routes),
    fixed: item.fixed !== false,
    ...(factor !== undefined ? { factor } : {}),
    until: item.until,
    text: typeof item.text === 'string' ? item.text : '',
    summary: typeof item.summary === 'string' ? item.summary : '',
    source: item.source === 'interpreter' ? 'interpreter' : 'user',
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    ...(item.origin && typeof item.origin.key === 'string' && typeof item.origin.option === 'string'
      ? { origin: { key: item.origin.key, option: item.origin.option } }
      : {}),
  };
};

export const createOverrideStore = ({ dataDir = resolveOpenCodeDataDir(), now = () => Date.now() } = {}) => {
  const overridesFile = path.join(dataDir, 'route-overrides.json');
  const feedbackFile = path.join(dataDir, 'route-feedback.jsonl');

  // A torn or otherwise unparseable overrides file is user data, not an
  // empty store: move its bytes aside before any later save can overwrite
  // them, and name the preserved copy so the loss is recoverable.
  const preserveCorruptFile = (error) => {
    const preservedFile = `${overridesFile}.corrupt-${now()}`;
    try {
      renameSyncWithRetry((from, to) => fs.renameSync(from, to), overridesFile, preservedFile);
      console.warn(`Failed to read route overrides file: preserved the unreadable file at ${preservedFile}:`, error);
      return true;
    } catch (preserveError) {
      console.warn('Failed to read route overrides file:', error);
      console.warn(`Failed to preserve the unreadable route overrides file at ${preservedFile}:`, preserveError);
      return false;
    }
  };

  const preserveCorruptFileIfPresent = () => {
    let raw;
    try {
      raw = fs.readFileSync(overridesFile, 'utf8');
    } catch {
      return;
    }
    try {
      JSON.parse(raw);
    } catch (error) {
      preserveCorruptFile(error);
    }
  };

  const readAll = () => {
    let raw;
    try {
      raw = fs.readFileSync(overridesFile, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('Failed to read route overrides file:', error);
      }
      return [];
    }
    let list;
    try {
      list = JSON.parse(raw)?.overrides;
    } catch (error) {
      preserveCorruptFile(error);
      return [];
    }
    return Array.isArray(list) ? list.map(parseOverride).filter(Boolean) : [];
  };

  const save = (overrides) => {
    const live = overrides.filter((item) => item.until > now());
    fs.mkdirSync(dataDir, { recursive: true });
    preserveCorruptFileIfPresent();
    const temporaryFile = `${overridesFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temporaryFile, JSON.stringify({ version: 1, overrides: live }, null, 2));
      renameSyncWithRetry((from, to) => fs.renameSync(from, to), temporaryFile, overridesFile);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryFile);
      } catch {
        // The temp file may never have been created; the write error stands.
      }
      throw error;
    }
    return live;
  };

  const list = () => readAll().filter((item) => item.until > now());

  const add = (items) => {
    const incoming = new Set(items.map((item) => item.id));
    return save([...readAll().filter((existing) => !incoming.has(existing.id)), ...items]);
  };

  const remove = (id) => {
    const existing = readAll();
    if (!existing.some((item) => item.id === id)) return false;
    save(existing.filter((item) => item.id !== id));
    return true;
  };

  const recordFeedback = (entry) => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(feedbackFile, `${JSON.stringify({ time: now(), ...entry })}\n`);
  };

  const readFeedback = () => {
    let text;
    try {
      text = fs.readFileSync(feedbackFile, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  };

  return { list, add, remove, recordFeedback, readFeedback, overridesFile, feedbackFile };
};
