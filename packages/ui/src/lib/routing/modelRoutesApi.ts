/**
 * Client for the OpenChamber model-pool routes (`/api/model-routes`). The
 * server owns the OpenCode config file; this module speaks HTTP and parses
 * what comes back. A 404 means the build has no model pools at all and is
 * reported as `available: false`, never as an empty map.
 *
 * Each pool is read on its own. One the structured editor cannot represent
 * stays the JSON the server sent, with the path the editor stopped at, and
 * goes back unchanged unless the user edits that JSON. So no config can hide
 * the other pools, and a save never drops a key it did not show.
 */
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

export const AUTONOMY_LEVELS = ['fixed', 'rules', 'adaptive', 'predictive', 'agent'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

// What the structured editor reads and writes. Every object is strict: a key
// the editor does not know makes the pool JSON-only, so it is never dropped.
// A level maps to the variant a model runs it at, or to false when the model
// sits that level out.
const variantChoiceSchema = z.union([z.string(), z.literal(false)]);

const targetSchema = z.union([
  z.string().min(1),
  z.strictObject({
    model: z.string().min(1),
    defaultVariant: z.string().optional(),
    variants: z.record(z.string(), variantChoiceSchema).optional(),
    until: z.number().int().positive().optional(),
  }),
]);

const healthSchema = z.strictObject({
  firstTokenTimeoutMs: z.union([z.number(), z.literal(false)]).optional(),
  maxResponseTimeMs: z.number().optional(),
  minOutputTokensPerSecond: z.number().optional(),
  sampleWindow: z.number().optional(),
  slowThreshold: z.number().optional(),
  cooldownMs: z.number().optional(),
  quotaCooldownMs: z.number().optional(),
});

const budgetSchema = z.strictObject({
  requestsPerMinute: z.number().optional(),
  requestsPerDay: z.number().optional(),
  tokensPerMinute: z.number().optional(),
  tokensPerDay: z.number().optional(),
  softLimit: z.number().optional(),
});

// The editor shows no schedule field and keeps schedules as read; they are
// checked only for the keys and value types OpenCode defines
// (packages/schema/src/config/model-routes.ts).
const scheduleWindowSchema = z.strictObject({
  daysOfWeek: z.array(z.union([z.string(), z.number()])).optional(),
  daysOfMonth: z.array(z.number()).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  timezone: z.string().optional(),
  from: z.number().optional(),
  until: z.number().optional(),
});

const scheduleSchema = z.strictObject({
  id: z.string().optional(),
  targets: z.array(z.string()).optional(),
  when: scheduleWindowSchema,
  factor: z.number().optional(),
  weight: z.number().optional(),
  note: z.string().optional(),
});

// The editor shows the keys that pick models by pattern, the declared levels
// and the variant rules, and keeps them as read; they are edited as JSON.
const variantRuleSchema = z.strictObject({
  match: z.string(),
  map: z.record(z.string(), variantChoiceSchema),
});

const modelRouteSchema = z.strictObject({
  name: z.string().optional(),
  // Optional when include, contains or match supply the models.
  targets: z.array(targetSchema).optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  contains: z.array(z.string()).optional(),
  notContains: z.array(z.string()).optional(),
  match: z.string().optional(),
  levels: z.array(z.string()).optional(),
  variantRules: z.array(variantRuleSchema).optional(),
  autonomy: z.enum(AUTONOMY_LEVELS).optional(),
  selection: z.enum(['ordered', 'round-robin', 'weighted']).optional(),
  weights: z.record(z.string(), z.number()).optional(),
  attempts: z.number().optional(),
  hedgeAfterMs: z.number().optional(),
  health: healthSchema.optional(),
  budgets: z.record(z.string(), budgetSchema).optional(),
  schedules: z.array(scheduleSchema).optional(),
});

export type ModelRoute = z.infer<typeof modelRouteSchema>;
export type ModelRouteTarget = z.infer<typeof targetSchema>;

const jsonValueSchema = z.json();
type JsonValue = z.infer<typeof jsonValueSchema>;

/**
 * One pool as the config holds it. An `editable` pool opens in the structured
 * editor. A `json` pool is the JSON the server sent, kept as it is;
 * `unreadablePath` names the first value the editor cannot show, such as
 * `targets[0].providerID`, and is empty when the pool is not an object.
 */
export type ModelRouteEntry =
  | { readonly kind: 'editable'; readonly route: ModelRoute }
  | { readonly kind: 'json'; readonly json: JsonValue; readonly unreadablePath: string };

const formatPath = (path: readonly PropertyKey[]): string =>
  path.reduce<string>((text, key) => {
    if (Number.isInteger(key)) return `${text}[${String(key)}]`;
    return text ? `${text}.${String(key)}` : String(key);
  }, '');

/** The path of the first value the editor could not read, from the schema's issues. */
const unreadablePathOf = (issues: readonly z.core.$ZodIssue[], parent: readonly PropertyKey[] = []): string => {
  const [issue] = issues;
  if (!issue) return formatPath(parent);
  const path = [...parent, ...issue.path];
  if (issue.code === 'unrecognized_keys') return formatPath([...path, ...issue.keys.slice(0, 1)]);
  if (issue.code === 'invalid_union') {
    // The option that read furthest into the value is the one the user meant:
    // a deeper path wins, and at the same depth one that accepted the type.
    const reach = (option: readonly z.core.$ZodIssue[]) => {
      const [first] = option;
      return first ? first.path.length * 2 + (first.code === 'invalid_type' ? 0 : 1) : -1;
    };
    const closest = issue.errors.reduce<z.core.$ZodIssue[]>((best, option) => (reach(option) > reach(best) ? option : best), []);
    return unreadablePathOf(closest, path);
  }
  return formatPath(path);
};

/** Reads one pool for the editor; a pool the editor cannot represent stays JSON. */
const readModelRouteEntry = (json: JsonValue): ModelRouteEntry => {
  const parsed = modelRouteSchema.safeParse(json);
  return parsed.success
    ? { kind: 'editable', route: parsed.data }
    : { kind: 'json', json, unreadablePath: unreadablePathOf(parsed.error.issues) };
};

/** Reads a pool from its JSON view. Throws when the text is not JSON; any JSON value is a pool the server then checks. */
export const readModelRouteJsonText = (text: string): ModelRouteEntry => readModelRouteEntry(jsonValueSchema.parse(JSON.parse(text)));

/** The JSON a pool saves as. */
export const modelRouteEntryJson = (entry: ModelRouteEntry): ModelRoute | JsonValue => (entry.kind === 'editable' ? entry.route : entry.json);

const modelRouteTuningSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalMinutes: z.number().optional(),
    windowHours: z.number().optional(),
  })
  .passthrough();

export type ModelRouteTuning = z.infer<typeof modelRouteTuningSchema>;

/** Review settings the editor cannot read: they stay as the config holds them and are not editable here. */
export const UNREADABLE_TUNING = 'unreadable';

const poolProblemSchema = z.object({
  message: z.string(),
  // True when OpenCode refuses the value too and runs without the pool.
  skipsPool: z.boolean(),
});

export type PoolProblem = z.infer<typeof poolProblemSchema>;

const poolProblemsSchema = z.record(z.string(), z.array(poolProblemSchema));

/** What OpenChamber's check found, per pool id; pools without problems are absent. */
export type PoolProblems = z.infer<typeof poolProblemsSchema>;

const modelRoutesPayloadSchema = z.object({
  routes: z.record(z.string(), jsonValueSchema),
  tuning: jsonValueSchema.optional(),
  path: z.string().optional(),
  // Servers from before per-pool problems send none.
  problems: poolProblemsSchema.optional(),
});

type ModelRoutesState = {
  routes: Record<string, ModelRouteEntry>;
  problems: PoolProblems;
  tuning: ModelRouteTuning | null | typeof UNREADABLE_TUNING;
  path?: string;
  available: boolean;
};

const readModelRoutesState = (payload: z.infer<typeof modelRoutesPayloadSchema>): ModelRoutesState => {
  const tuning = modelRouteTuningSchema.nullable().safeParse(payload.tuning ?? null);
  return {
    routes: Object.fromEntries(Object.entries(payload.routes).map(([id, json]) => [id, readModelRouteEntry(json)])),
    problems: payload.problems ?? {},
    tuning: tuning.success ? tuning.data : UNREADABLE_TUNING,
    path: payload.path,
    available: true,
  };
};

const errorPayloadSchema = z.object({ error: z.string().min(1) });

export const fetchModelRoutes = async (): Promise<ModelRoutesState> => {
  const response = await runtimeFetch('/api/model-routes');
  if (response.status === 404) return { routes: {}, problems: {}, tuning: null, available: false };
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Model pools request failed (${response.status})`);
  }
  return readModelRoutesState(modelRoutesPayloadSchema.parse(payload));
};

type ModelRoutesWrite = {
  routes?: Record<string, ModelRoute | JsonValue>;
  tuning?: ModelRouteTuning | null;
  force?: boolean;
};

const putModelRoutes = (body: ModelRoutesWrite): Promise<Response> =>
  runtimeFetch('/api/model-routes', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const refusalSchema = z.object({ problems: poolProblemsSchema });

type ModelRoutesSaveResult =
  | { readonly kind: 'saved'; readonly state: ModelRoutesState }
  | { readonly kind: 'refused'; readonly problems: PoolProblems };

/**
 * Sends every pool. The server checks only the pools that differ from the
 * config and refuses the save, naming their problems, when one has any;
 * `force` writes them anyway and the problems come back with the saved state.
 */
export const saveModelRoutes = async (
  routes: Record<string, ModelRouteEntry>,
  options: { force?: boolean } = {},
): Promise<ModelRoutesSaveResult> => {
  const body: ModelRoutesWrite = {
    routes: Object.fromEntries(Object.entries(routes).map(([id, entry]) => [id, modelRouteEntryJson(entry)])),
  };
  if (options.force === true) body.force = true;
  const response = await putModelRoutes(body);
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) return { kind: 'saved', state: readModelRoutesState(modelRoutesPayloadSchema.parse(payload)) };
  const refusal = refusalSchema.safeParse(payload);
  if (response.status === 400 && refusal.success) return { kind: 'refused', problems: refusal.data.problems };
  const failure = errorPayloadSchema.safeParse(payload);
  throw new Error(failure.success ? failure.data.error : `Model pools request failed (${response.status})`);
};

/** Saves the automatic-review settings; null removes them so OpenCode's defaults apply. */
export const saveModelRouteTuning = async (tuning: ModelRouteTuning | null): Promise<ModelRoutesState> => {
  const response = await putModelRoutes({ tuning });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Model pools request failed (${response.status})`);
  }
  return readModelRoutesState(modelRoutesPayloadSchema.parse(payload));
};

const routeTargetStatsSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  attempts: z.number(),
  failures: z.number(),
  timeouts: z.number(),
  avgFirstTokenMs: z.number().nullable(),
  avgTokensPerSecond: z.number().nullable(),
  lastAttempt: z.number().nullable().optional(),
});

const routeErrorSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  tag: z.string().nullable(),
  code: z.string().nullable(),
  status: z.number().nullable(),
  count: z.number(),
  lastTime: z.number().nullable().optional(),
  lastMessage: z.string().nullable(),
});

const hedgeAccuracySchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  hedges: z.number(),
  wins: z.number(),
});

const routeStatsSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  windowHours: z.number().optional(),
  targets: z.array(routeTargetStatsSchema).optional(),
  errors: z.array(routeErrorSchema).optional(),
  hedges: z.array(hedgeAccuracySchema).optional(),
});

export type RouteTargetStats = z.infer<typeof routeTargetStatsSchema>;
export type RouteErrorGroup = z.infer<typeof routeErrorSchema>;
export type HedgeAccuracy = z.infer<typeof hedgeAccuracySchema>;
type RouteStats = z.infer<typeof routeStatsSchema>;

export const fetchRouteStats = async (hours = 24): Promise<RouteStats> => {
  const response = await runtimeFetch(`/api/model-routes/stats?hours=${hours}`);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Routing telemetry request failed (${response.status})`);
  }
  return routeStatsSchema.parse(payload);
};

const messageAttributionSelectionSchema = z.object({
  mode: z.string(),
  reason: z.string(),
});

const messageAttributionFailoverSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  variant: z.string().nullable(),
  errorTag: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

const messageAttributionSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  variant: z.string().nullable(),
  routeID: z.string().nullable(),
  selection: messageAttributionSelectionSchema.nullable(),
  failover: messageAttributionFailoverSchema.nullable(),
});

const messageModelAttributionResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  messages: z.record(z.string(), messageAttributionSchema).optional(),
});

export type MessageModelAttribution = z.infer<typeof messageAttributionSchema>;
type MessageModelAttributionResponse = z.infer<typeof messageModelAttributionResponseSchema>;

/** Per-assistant-message pool/selection/failover attribution for one session, from OpenCode's routing tables. */
export const fetchMessageModelAttribution = async (sessionID: string): Promise<MessageModelAttributionResponse> => {
  const response = await runtimeFetch(`/api/model-routes/turns?sessionID=${encodeURIComponent(sessionID)}`);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Routing telemetry request failed (${response.status})`);
  }
  return messageModelAttributionResponseSchema.parse(payload);
};
