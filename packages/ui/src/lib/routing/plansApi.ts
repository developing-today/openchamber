/**
 * Client for the plan store (`/api/routing/plans`): the subscriptions and
 * quota windows the user keeps, the cost tier of each model, what each pool is
 * for, and the notes about how usage has felt. The server writes OpenCode's
 * data directory, where the `plan_info` and `route_usage` tools read the same
 * records. This module speaks HTTP and parses what comes back.
 */
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

export const PLAN_COVERAGE = ['subscription', 'credits', 'metered', 'free', 'trial'] as const;
export const PLAN_TIERS = ['cheap', 'standard', 'frontier'] as const;
export const PLAN_UNITS = ['requests', 'messages', 'tokens', 'usd', 'percent', 'other'] as const;
export const PLAN_STATUSES = ['active', 'expired', 'cancelled', 'unknown'] as const;
export const PLAN_PERIODS = ['monthly', 'yearly', 'once'] as const;
export const NOTE_KINDS = ['experience', 'expectation', 'plan-change', 'correction', 'other'] as const;

export type PlanCoverage = (typeof PLAN_COVERAGE)[number];
export type PlanTier = (typeof PLAN_TIERS)[number];
export type PlanUnit = (typeof PLAN_UNITS)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PlanPeriod = (typeof PLAN_PERIODS)[number];
export type NoteKind = (typeof NOTE_KINDS)[number];

const quotaWindowSchema = z.object({
  name: z.string(),
  unit: z.enum(PLAN_UNITS),
  limit: z.number().optional(),
  windowHours: z.number().optional(),
  resetRule: z.string().optional(),
  resetAt: z.string().optional(),
  note: z.string().optional(),
});

const feeSchema = z.object({
  amount: z.number(),
  currency: z.string(),
  period: z.enum(PLAN_PERIODS),
  renewsOn: z.string().optional(),
});

const planSchema = z.object({
  id: z.string(),
  providerID: z.string(),
  label: z.string(),
  plan: z.string().optional(),
  coverage: z.enum(PLAN_COVERAGE),
  fee: feeSchema.optional(),
  quotas: z.array(quotaWindowSchema),
  expiresOn: z.string().optional(),
  status: z.enum(PLAN_STATUSES),
  verifiedAt: z.string().optional(),
  verifiedFrom: z.string().optional(),
  howToCheck: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PlanRecord = z.infer<typeof planSchema>;
export type QuotaWindow = z.infer<typeof quotaWindowSchema>;
export type PlanFee = z.infer<typeof feeSchema>;

const modelTierSchema = z.object({
  tier: z.enum(PLAN_TIERS),
  coveredBy: z.array(z.string()).optional(),
  note: z.string().optional(),
  updatedAt: z.string(),
});

const poolPurposeSchema = z.object({
  tier: z.enum(PLAN_TIERS).optional(),
  purpose: z.string().optional(),
  updatedAt: z.string(),
});

const planNoteSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(NOTE_KINDS),
  text: z.string(),
  source: z.enum(['user', 'model', 'ui']),
  providerID: z.string().optional(),
  planID: z.string().optional(),
  modelID: z.string().optional(),
  poolID: z.string().optional(),
});

export type PlanNote = z.infer<typeof planNoteSchema>;
type ModelTier = z.infer<typeof modelTierSchema>;
type PoolPurpose = z.infer<typeof poolPurposeSchema>;

const planStateSchema = z.object({
  plans: z.array(planSchema),
  models: z.record(z.string(), modelTierSchema),
  pools: z.record(z.string(), poolPurposeSchema),
  notes: z.array(planNoteSchema),
  skippedNotes: z.number().optional(),
});

export type PlanState = z.infer<typeof planStateSchema>;

const errorSchema = z.object({ error: z.string().min(1) });

const send = async (path: string, method: 'GET' | 'PUT' | 'POST', body?: unknown): Promise<unknown> => {
  const response = await runtimeFetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Could not save plan information (${response.status})`);
  }
  return payload;
};

export const fetchPlanState = async (): Promise<PlanState> => planStateSchema.parse(await send('/api/routing/plans', 'GET'));

/** Creates or updates a plan. A field set to null is cleared on the server; a field left out is kept. */
export const savePlanRecord = async (plan: Record<string, unknown>): Promise<PlanRecord> =>
  planSchema.parse(await send('/api/routing/plans/record', 'PUT', plan));

export const saveModelTier = async (input: {
  model: string;
  tier?: PlanTier;
  coveredBy?: string[] | null;
  note?: string | null;
}): Promise<ModelTier> => modelTierSchema.parse(await send('/api/routing/plans/model', 'PUT', input));

export const savePoolPurpose = async (input: {
  id: string;
  tier?: PlanTier | null;
  purpose?: string | null;
}): Promise<PoolPurpose> => poolPurposeSchema.parse(await send('/api/routing/plans/pool', 'PUT', input));

export const addPlanNote = async (input: {
  text: string;
  kind: NoteKind;
  providerID?: string;
  planID?: string;
  modelID?: string;
  poolID?: string;
}): Promise<PlanNote> => planNoteSchema.parse(await send('/api/routing/plans/notes', 'POST', input));
