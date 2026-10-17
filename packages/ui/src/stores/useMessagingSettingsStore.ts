/**
 * Settings → Messaging: the `messaging` section of OpenCode's config, the
 * live state of OpenCode's embedding model, and the topic presets and
 * variables with their current values.
 *
 * The section is read and written through the OpenChamber server, which owns
 * the file; OpenCode applies a change without a restart. A write shows at
 * once and rolls back when it fails, unless a newer change was made since.
 * A failed read never replaces a good snapshot of the same scope.
 */

import { create } from 'zustand';

import { readMessagingConfig, writeMessagingConfig, type MessagingConfig, type MessagingConfigSnapshot } from '@/lib/messagingConfigApi';
import { OpencodeApiError } from '@/lib/opencode/client';
import {
  configureMessagingModel,
  getMessagingModelStatus,
  listMessagingVars,
  setMessagingVar,
  type MessagingModelStatus,
  type MessagingVars,
} from '@/lib/opencode/messaging';
import { reportSettingsSaveState } from '@/lib/persistence';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

type ConfigState =
  | { kind: 'idle' }
  | { kind: 'loading'; scope: string }
  | { kind: 'ready'; scope: string; snapshot: MessagingConfigSnapshot }
  | { kind: 'failed'; scope: string; error: string };

type ModelState = { status: MessagingModelStatus | null; error: string | null; starting: boolean };
type VarsState = { key: string | null; data: MessagingVars | null; error: string | null };

type MessagingSettingsStore = {
  config: ConfigState;
  model: ModelState;
  vars: VarsState;
  load: (directory: string | null) => Promise<void>;
  /** Applies a change to the section; resolves false when the write failed and the change was rolled back. */
  update: (change: (config: MessagingConfig) => MessagingConfig) => Promise<boolean>;
  loadModel: () => Promise<void>;
  /** Downloads and starts the configured model now. */
  startModel: () => Promise<void>;
  /** Applies a tier to the running OpenCode right away; the config write makes it last. */
  applyTier: (tier: string) => Promise<void>;
  loadVars: (sessionID: string | null) => Promise<void>;
  /** Sets a global custom variable, or removes it when `value` is undefined. */
  setGlobalVar: (name: string, value: string | undefined, sessionID: string | null) => Promise<boolean>;
};

export const getMessagingSettingsScope = (directory: string | null): string => JSON.stringify([getRuntimeKey(), directory]);

const failureText = (caught: Error): string => (caught instanceof OpencodeApiError ? caught.detail : caught.message);

let readGeneration = 0;
let revision = 0;
/** The directory the page last read for; `undefined` until it asked once. */
let loadedDirectory: string | null | undefined;
let modelGeneration = 0;
let varsGeneration = 0;
let runtimeGeneration = 0;
let writeTail = Promise.resolve(true);
let savedConfig: MessagingConfig = {};

const varsKey = (sessionID: string | null): string => JSON.stringify([getRuntimeKey(), sessionID, true]);

export const useMessagingSettingsStore = create<MessagingSettingsStore>()((set, get) => ({
  config: { kind: 'idle' },
  model: { status: null, error: null, starting: false },
  vars: { key: null, data: null, error: null },

  load: async (directory) => {
    loadedDirectory = directory;
    const scope = getMessagingSettingsScope(directory);
    const generation = ++readGeneration;
    const current = get().config;
    if (!(current.kind === 'ready' && current.scope === scope)) set({ config: { kind: 'loading', scope } });
    // A config event can precede a save response. Read only after every admitted write settles.
    while (true) {
      const writes = writeTail;
      await writes;
      if (generation !== readGeneration) return;
      if (writes === writeTail) break;
    }
    const revisionAtStart = revision;
    try {
      const snapshot = await readMessagingConfig(directory);
      // A change made while this read was in flight is newer than what it saw.
      if (generation !== readGeneration || revision !== revisionAtStart) return;
      savedConfig = snapshot.config;
      set({ config: { kind: 'ready', scope, snapshot } });
    } catch (caught) {
      if (generation !== readGeneration || revision !== revisionAtStart) return;
      const latest = get().config;
      if (latest.kind === 'ready' && latest.scope === scope) return;
      set({ config: { kind: 'failed', scope, error: failureText(caught instanceof Error ? caught : new Error(String(caught))) } });
    }
  },

  update: async (change) => {
    const current = get().config;
    if (current.kind !== 'ready') return false;
    const next = change(current.snapshot.config);
    revision += 1;
    const mine = revision;
    const runtime = runtimeGeneration;
    set({ config: { ...current, snapshot: { ...current.snapshot, config: next } } });
    reportSettingsSaveState('saving');
    const write = writeTail.then(async () => {
      // Queued writes retired by a runtime switch fail without reaching the new host.
      if (runtime !== runtimeGeneration) return false;
      try {
        await writeMessagingConfig(next);
        if (runtime !== runtimeGeneration) return true;
        savedConfig = next;
        if (mine === revision) reportSettingsSaveState('saved');
        return true;
      } catch (caught) {
        if (runtime !== runtimeGeneration) return false;
        console.warn('[messaging] failed to save the settings', caught);
        if (mine === revision) {
          reportSettingsSaveState('error');
          const latest = get().config;
          if (latest.kind === 'ready' && latest.scope === current.scope) {
            set({ config: { ...latest, snapshot: { ...latest.snapshot, config: savedConfig } } });
          }
        }
        return false;
      }
    });
    writeTail = write;
    return write;
  },

  loadModel: async () => {
    const generation = ++modelGeneration;
    try {
      const status = await getMessagingModelStatus();
      if (generation !== modelGeneration) return;
      set({ model: { status, error: null, starting: false } });
    } catch (caught) {
      if (generation !== modelGeneration) return;
      set((state) => ({ model: { ...state.model, error: failureText(caught instanceof Error ? caught : new Error(String(caught))), starting: false } }));
    }
  },

  startModel: async () => {
    const generation = ++modelGeneration;
    set((state) => ({ model: { ...state.model, starting: true, error: null } }));
    try {
      const status = await configureMessagingModel({ start: true });
      if (generation !== modelGeneration) return;
      set({ model: { status, error: null, starting: false } });
    } catch (caught) {
      if (generation !== modelGeneration) return;
      set((state) => ({ model: { ...state.model, error: failureText(caught instanceof Error ? caught : new Error(String(caught))), starting: false } }));
    }
  },

  applyTier: async (tier) => {
    const generation = ++modelGeneration;
    try {
      const status = await configureMessagingModel({ tier });
      if (generation !== modelGeneration) return;
      set({ model: { status, error: null, starting: false } });
    } catch (caught) {
      if (generation !== modelGeneration) return;
      set((state) => ({ model: { ...state.model, error: failureText(caught instanceof Error ? caught : new Error(String(caught))), starting: false } }));
    }
  },

  loadVars: async (sessionID) => {
    const generation = ++varsGeneration;
    const key = varsKey(sessionID);
    set((state) => ({ vars: { key, data: state.vars.key === key ? state.vars.data : null, error: null } }));
    try {
      const data = await listMessagingVars({ as: sessionID ?? undefined, values: true });
      if (generation !== varsGeneration) return;
      set({ vars: { key, data, error: null } });
    } catch (caught) {
      if (generation !== varsGeneration) return;
      set((state) => ({ vars: { key, data: state.vars.key === key ? state.vars.data : null, error: failureText(caught instanceof Error ? caught : new Error(String(caught))) } }));
    }
  },

  setGlobalVar: async (name, value, sessionID) => {
    const runtime = getRuntimeKey();
    const generation = runtimeGeneration;
    const key = varsKey(sessionID);
    try {
      await setMessagingVar({ scope: 'global', name, value });
      if (runtime === getRuntimeKey() && generation === runtimeGeneration && (get().vars.key === key || get().vars.key === null)) {
        void get().loadVars(sessionID);
      }
      return true;
    } catch (caught) {
      if (runtime === getRuntimeKey() && generation === runtimeGeneration && get().vars.key === key) {
        set((state) => ({ vars: { ...state.vars, error: failureText(caught instanceof Error ? caught : new Error(String(caught))) } }));
      }
      return false;
    }
  },
}));

/** Re-read after a config change, but only once the page asked for the data. */
export const refreshMessagingSettingsIfLoaded = async (): Promise<void> => {
  if (loadedDirectory === undefined) return;
  await useMessagingSettingsStore.getState().load(loadedDirectory);
};

subscribeRuntimeEndpointChanged(() => {
  runtimeGeneration += 1;
  writeTail = Promise.resolve(true);
  savedConfig = {};
  loadedDirectory = undefined;
  readGeneration += 1;
  modelGeneration += 1;
  varsGeneration += 1;
  useMessagingSettingsStore.setState({
    config: { kind: 'idle' },
    model: { status: null, error: null, starting: false },
    vars: { key: null, data: null, error: null },
  });
});
