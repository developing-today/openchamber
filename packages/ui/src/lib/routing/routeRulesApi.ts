/**
 * Client for the sentence-driven routing rules (`/api/model-routes/rules`,
 * `/interpret`, `/settings`, `/wait`, `/local`). The server decides what a
 * sentence means and stores the rules where OpenCode reads them; this module
 * only speaks HTTP and parses the answers.
 */
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const ruleSchema = z.object({
  id: z.string(),
  action: z.enum(['avoid', 'prefer', 'allow-over-budget']),
  providers: z.array(z.string()),
  models: z.array(z.string()),
  fixed: z.boolean(),
  factor: z.number().optional(),
  until: z.number(),
  text: z.string(),
  summary: z.string(),
  source: z.enum(['user', 'interpreter']),
  createdAt: z.number(),
  origin: z.object({ key: z.string(), option: z.string() }).optional(),
});

export type RouteRule = z.infer<typeof ruleSchema>;

const rulesSchema = z.object({ rules: z.array(ruleSchema) });

const interpretResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    stage: z.string(),
    confidence: z.string(),
    summary: z.string(),
    rules: z.array(ruleSchema),
  }),
  z.object({
    status: z.literal('clarify'),
    key: z.string(),
    question: z.string(),
    options: z.array(z.string()),
  }),
  z.object({ status: z.literal('unknown'), reason: z.string() }),
]);

export type InterpretResult = z.infer<typeof interpretResultSchema>;

const settingsSchema = z.object({
  stages: z.object({ keywords: z.boolean(), local: z.boolean(), external: z.boolean() }),
  learnAfter: z.number(),
  waitPercentile: z.number(),
  waitMinSamples: z.number(),
});

export type RouteRulesSettings = z.infer<typeof settingsSchema>;

const localModelSchema = z.object({
  label: z.string(),
  bytes: z.number(),
  installed: z.boolean(),
  downloadedBytes: z.number(),
  downloading: z.boolean(),
  error: z.string().nullable(),
});

export type LocalModelStatus = z.infer<typeof localModelSchema>;

const waitSchema = z.object({
  active: z.object({ until: z.number(), remainingMs: z.number() }).nullable(),
  expectedMs: z.number().nullable(),
  basis: z.string(),
  samples: z.number(),
  reason: z.string().optional(),
});

export type WaitEstimate = z.infer<typeof waitSchema>;

interface RoutingContext {
  providers: string[];
  models: Array<{ id: string; providerID: string }>;
}

export const routingContextFromProviders = (
  providers: ReadonlyArray<{ id: string; models: ReadonlyArray<{ id: string }> }>,
): RoutingContext => ({
  providers: providers.map((provider) => provider.id),
  models: providers.flatMap((provider) => provider.models.map((model) => ({ id: model.id, providerID: provider.id }))),
});

const errorPayloadSchema = z.object({ error: z.string().min(1) });

const call = async <T extends z.ZodType>(url: string, schema: T, init?: RequestInit): Promise<z.infer<T>> => {
  const response = await runtimeFetch(url, init);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Routing request failed (${response.status})`);
  }
  return schema.parse(payload);
};

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const fetchRouteRules = async (): Promise<RouteRule[]> =>
  (await call('/api/model-routes/rules', rulesSchema)).rules;

export const interpretRoute = (text: string, context: RoutingContext): Promise<InterpretResult> =>
  call('/api/model-routes/interpret', interpretResultSchema, jsonInit('POST', { text, context }));

export const answerRouteQuestion = (
  text: string,
  context: RoutingContext,
  key: string,
  label: string,
): Promise<InterpretResult> =>
  call('/api/model-routes/interpret/answer', interpretResultSchema, jsonInit('POST', { text, context, key, label }));

export const undoRouteRule = async (id: string): Promise<RouteRule[]> =>
  (await call(`/api/model-routes/rules/${encodeURIComponent(id)}`, rulesSchema, { method: 'DELETE' })).rules;

export const fetchRouteSettings = (): Promise<RouteRulesSettings> =>
  call('/api/model-routes/settings', settingsSchema);

export const saveRouteSettings = (settings: RouteRulesSettings): Promise<RouteRulesSettings> =>
  call('/api/model-routes/settings', settingsSchema, jsonInit('PUT', settings));

export const fetchWaitEstimate = (providerID: string, modelID: string): Promise<WaitEstimate> =>
  call(
    `/api/model-routes/wait?provider=${encodeURIComponent(providerID)}&model=${encodeURIComponent(modelID)}`,
    waitSchema,
  );

export const fetchLocalModel = (): Promise<LocalModelStatus> => call('/api/model-routes/local', localModelSchema);

export const downloadLocalModel = (): Promise<LocalModelStatus> =>
  call('/api/model-routes/local/download', localModelSchema, { method: 'POST' });
