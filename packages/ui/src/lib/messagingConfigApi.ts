/**
 * Client for the OpenChamber route that owns the `messaging` section of
 * OpenCode's config (`/api/config/messaging`). The server writes the file
 * Settings owns (`OPENCODE_CONFIG`, else the user's `opencode.json`); OpenCode
 * watches it and applies a change without a restart. This module speaks HTTP
 * and parses what comes back; a failed read throws.
 */
import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

const deliverySchema = z.enum(['none', 'inbox', 'wake']);

const remoteSchema = z.object({
  url: z.string(),
  model: z.string(),
  key: z.string().optional(),
  dimensions: z.number().optional(),
});
export type MessagingRemoteConfig = z.infer<typeof remoteSchema>;

const embeddingSchema = z.object({
  tier: z.string().optional(),
  url: z.string().optional(),
  path: z.string().optional(),
  pooling: z.enum(['last', 'mean', 'cls']).optional(),
  query: z.string().optional(),
  server: z.string().optional(),
  autostart: z.boolean().optional(),
  gpu_layers: z.number().optional(),
  threads: z.number().optional(),
  remote: remoteSchema.optional(),
});
export type MessagingEmbeddingConfig = z.infer<typeof embeddingSchema>;

const configSchema = z.object({
  presets: z.record(z.string(), z.string()).optional(),
  vars: z.record(z.string(), z.string()).optional(),
  session_start: z.string().optional(),
  delivery: z.object({
    direct: deliverySchema.optional(),
    root: deliverySchema.optional(),
    user: z.enum(['hidden', 'visible', 'wake']).optional(),
  }).optional(),
  search: z.object({
    match: z.enum(['exact', 'regex', 'fuzzy', 'semantic', 'hybrid', 'advanced']).optional(),
    model: z.string().optional(),
  }).optional(),
  // A bare tier name is OpenCode's shorthand for `{ tier }`; it reads as the object form, which is what Settings writes back.
  embedding: z.union([z.string().transform((tier): MessagingEmbeddingConfig => ({ tier })), embeddingSchema]).optional(),
});
export type MessagingConfig = z.infer<typeof configSchema>;

const readResponseSchema = z.object({
  messaging: configSchema.nullable(),
  path: z.string(),
  projectPath: z.string().nullable(),
});

export type MessagingConfigSnapshot = {
  config: MessagingConfig;
  /** The file Settings writes. */
  path: string;
  /** A project config that sets `messaging` and so overrides what Settings writes for that project. */
  projectPath: string | null;
};

const errorSchema = z.object({ error: z.string() });

const failure = async (response: Response, fallback: string): Promise<Error> => {
  const body = errorSchema.safeParse(await response.json().catch(() => null));
  return new Error(body.data?.error ?? `${fallback} (${response.status})`);
};

export async function readMessagingConfig(directory: string | null): Promise<MessagingConfigSnapshot> {
  const response = await runtimeFetch('/api/config/messaging', {
    headers: { Accept: 'application/json' },
    query: directory ? { directory } : undefined,
  });
  if (!response.ok) throw await failure(response, 'Could not read the messaging settings');
  const parsed = readResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('The messaging settings are in a form this version does not read');
  return { config: parsed.data.messaging ?? {}, path: parsed.data.path, projectPath: parsed.data.projectPath };
}

/** Replaces the whole section; an empty section removes the key. */
export async function writeMessagingConfig(config: MessagingConfig): Promise<void> {
  const response = await runtimeFetch('/api/config/messaging', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ messaging: Object.keys(config).length > 0 ? config : null }),
  });
  if (!response.ok) throw await failure(response, 'Could not save the messaging settings');
}

