import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

const disabledProvidersSchema = z.object({ providers: z.array(z.string()) });
const errorSchema = z.object({ error: z.string().min(1) });

/**
 * Providers turned off in the user's OpenCode config (`disabled_providers`).
 * OpenCode leaves them out of its provider list entirely, so this is the only
 * way Settings can show them again. Null where the runtime has no OpenChamber
 * server to ask (VS Code): the feature is not offered there.
 */
const fetchDisabledProviders = async (): Promise<string[] | null> => {
  const response = await runtimeFetch('/api/provider/disabled');
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read disabled providers (${response.status})`);
  return disabledProvidersSchema.parse(await response.json()).providers;
};

// The last list read from the current runtime, kept so every part of the app
// filters from the same read. A location OpenCode has not reloaded since a
// provider was turned off still lists that provider; this list is what keeps
// it out of that location's picker. The snapshot belongs to the runtime it
// was read from; after a runtime switch it is ignored until a read from the
// new runtime lands. A `null` list is a read answer too: the runtime has no
// OpenChamber server, so there is nothing to filter with.
let snapshot: { runtimeKey: string; providers: string[] | null } | null = null;
let inFlight: { runtimeKey: string; promise: Promise<string[] | null> } | null = null;
let latestRead = 0;

/** The last list read from the current runtime, or `null` when there is none. */
export const peekDisabledProviders = (): string[] | null =>
  snapshot?.runtimeKey === getRuntimeKey() ? snapshot.providers : null;

/** Keeps a list the caller just read or wrote, so later reads reuse it. */
export const rememberDisabledProviders = (providers: string[] | null): void => {
  // A write is newer than every read already in flight: advancing the read
  // generation is what stops such a read from writing its pre-write list
  // back over this one when it lands.
  latestRead += 1;
  snapshot = { runtimeKey: getRuntimeKey(), providers };
};

/**
 * Reads the list again and keeps it. A read started earlier never replaces
 * one started later, and a Settings write (rememberDisabledProviders)
 * advances the same generation, so a slow first read cannot bring back the
 * state from before a Settings change either. Throws when the list cannot
 * be read; a failed read is never an empty list.
 */
export const loadDisabledProviders = async (): Promise<string[] | null> => {
  const runtimeKey = getRuntimeKey();
  const read = ++latestRead;
  const providers = await fetchDisabledProviders();
  if (read === latestRead && runtimeKey === getRuntimeKey()) {
    snapshot = { runtimeKey, providers };
    return providers;
  }
  // Superseded while in flight - by a newer read, a provider toggle, or a
  // runtime switch. The fetched list is stale: answer with the latest
  // snapshot for the current runtime instead, so no caller filters a
  // catalog with the pre-toggle list.
  return peekDisabledProviders();
};

/**
 * The current runtime's list, reading it once when no read has landed yet.
 * Callers that arrive while that read runs share it. A failure answers
 * `null`, the caller keeps the providers it has, and the failure is not
 * kept: the next caller reads again.
 */
export const ensureDisabledProviders = (): Promise<string[] | null> => {
  const runtimeKey = getRuntimeKey();
  if (snapshot?.runtimeKey === runtimeKey) return Promise.resolve(snapshot.providers);
  if (inFlight?.runtimeKey === runtimeKey) return inFlight.promise;
  const promise = loadDisabledProviders()
    .catch((error) => {
      console.warn('[providers] could not read disabled providers:', error instanceof Error ? error.message : String(error));
      return null;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { runtimeKey, promise };
  return promise;
};

/**
 * Reads the list once the app has started, so the first catalog a picker
 * shows is already filtered. A failure is left for the next catalog load
 * or Settings visit to retry.
 */
export const prefetchDisabledProviders = (): void => {
  void ensureDisabledProviders();
};

/** Turns a provider off or back on; answers with the new list. */
export const setProviderDisabled = async (providerId: string, disabled: boolean): Promise<string[]> => {
  const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/disabled`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Could not update the provider (${response.status})`);
  }
  const providers = disabledProvidersSchema.parse(payload).providers;
  rememberDisabledProviders(providers);
  return providers;
};
