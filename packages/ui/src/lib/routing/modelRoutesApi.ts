/**
 * Client for the OpenChamber model-pool routes (`/api/model-routes`). The
 * server owns the OpenCode config file; this module speaks HTTP and parses
 * what comes back. A 404 means the build has no model pools at all and is
 * reported as `available: false`, never as an empty map.
 */
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

export const AUTONOMY_LEVELS = ['fixed', 'rules', 'adaptive', 'predictive', 'agent'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

const targetSchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    defaultVariant: z.string().optional(),
    variants: z.record(z.string(), z.string()).optional(),
    until: z.number().int().positive().optional(),
  }),
]);

const healthSchema = z
  .object({
    firstTokenTimeoutMs: z.union([z.number(), z.literal(false)]).optional(),
    maxResponseTimeMs: z.number().optional(),
    minOutputTokensPerSecond: z.number().optional(),
    sampleWindow: z.number().optional(),
    slowThreshold: z.number().optional(),
    cooldownMs: z.number().optional(),
    quotaCooldownMs: z.number().optional(),
  })
  .passthrough();

const budgetSchema = z
  .object({
    requestsPerMinute: z.number().optional(),
    requestsPerDay: z.number().optional(),
    tokensPerMinute: z.number().optional(),
    tokensPerDay: z.number().optional(),
    softLimit: z.number().optional(),
  })
  .passthrough();

// Loose on purpose: a hand-written window the editor cannot fully read still
// loads and shows, and the server names what is wrong with it on save.
const scheduleWindowSchema = z
  .object({
    daysOfWeek: z.array(z.union([z.string(), z.number()])).optional(),
    daysOfMonth: z.array(z.number()).optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    timezone: z.string().optional(),
    from: z.number().optional(),
    until: z.number().optional(),
  })
  .passthrough();

/** A time-bound weight change inside one pool (OpenCode's `Schedule`). */
const routeScheduleSchema = z
  .object({
    id: z.string().optional(),
    targets: z.array(z.string()).optional(),
    when: scheduleWindowSchema.optional(),
    factor: z.number().optional(),
    weight: z.number().optional(),
    note: z.string().optional(),
  })
  .passthrough();

/** A time-bound weight change across pools (OpenCode's `GlobalSchedule`). */
const globalScheduleSchema = routeScheduleSchema
  .extend({
    providers: z.array(z.string()).optional(),
    models: z.array(z.string()).optional(),
    routes: z.array(z.string()).optional(),
  })
  .passthrough();

export type ScheduleWindow = z.infer<typeof scheduleWindowSchema>;
export type GlobalSchedule = z.infer<typeof globalScheduleSchema>;

const modelRouteSchema = z
  .object({
    name: z.string().optional(),
    targets: z.array(targetSchema),
    autonomy: z.enum(AUTONOMY_LEVELS).optional(),
    selection: z.enum(['ordered', 'round-robin', 'weighted']).optional(),
    weights: z.record(z.string(), z.number()).optional(),
    attempts: z.number().optional(),
    hedgeAfterMs: z.number().optional(),
    health: healthSchema.optional(),
    budgets: z.record(z.string(), budgetSchema).optional(),
    schedules: z.array(routeScheduleSchema).optional(),
  })
  .passthrough();

export type ModelRoute = z.infer<typeof modelRouteSchema>;
export type ModelRouteTarget = z.infer<typeof targetSchema>;

const modelRouteTuningSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalMinutes: z.number().optional(),
    windowHours: z.number().optional(),
  })
  .passthrough();

export type ModelRouteTuning = z.infer<typeof modelRouteTuningSchema>;

const modelRoutesStateSchema = z.object({
  routes: z.record(z.string(), modelRouteSchema),
  tuning: modelRouteTuningSchema.nullable().optional(),
  schedules: z.array(globalScheduleSchema).nullable().optional(),
  path: z.string().optional(),
});

type ModelRoutesState = z.infer<typeof modelRoutesStateSchema> & { available: boolean };

const errorPayloadSchema = z.object({ error: z.string().min(1) });

export const fetchModelRoutes = async (): Promise<ModelRoutesState> => {
  const response = await runtimeFetch('/api/model-routes');
  if (response.status === 404) return { routes: {}, available: false };
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Model pools request failed (${response.status})`);
  }
  return { ...modelRoutesStateSchema.parse(payload), available: true };
};

const putModelRoutes = async (body: {
  routes?: Record<string, ModelRoute>;
  tuning?: ModelRouteTuning | null;
  schedules?: GlobalSchedule[] | null;
}): Promise<ModelRoutesState> => {
  const response = await runtimeFetch('/api/model-routes', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Model pools request failed (${response.status})`);
  }
  return { ...modelRoutesStateSchema.parse(payload), available: true };
};

export const saveModelRoutes = (routes: Record<string, ModelRoute>): Promise<ModelRoutesState> => putModelRoutes({ routes });

/** Saves the automatic-review settings; null removes them so OpenCode's defaults apply. */
export const saveModelRouteTuning = (tuning: ModelRouteTuning | null): Promise<ModelRoutesState> => putModelRoutes({ tuning });

/** Saves the schedules that apply across pools; null removes the list from the config. */
export const saveModelRouteSchedules = (schedules: GlobalSchedule[] | null): Promise<ModelRoutesState> => putModelRoutes({ schedules });

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
