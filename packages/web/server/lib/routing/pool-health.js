/**
 * Pool health: for every target in every `experimental.model_routes` pool, how
 * many sessions are on it right now and, when it is linked to a plan
 * (`pool-plan-links.js`), how close that plan looks to its quota window.
 *
 * The point is blast radius: a target with several active sessions busts all
 * of their caches at once if its plan runs out, where a target with one does
 * not touch the others. This view is read-only and advisory — it never moves
 * a session or changes a weight by itself, only computes what a human (or a
 * later automatic step) would need to decide that.
 *
 * The quota projection is an estimate from recent traffic, not an
 * authoritative count: OpenCode and the provider are the only ones who know
 * the plan's actual remaining quota. Read as "at this rate", not as a meter.
 */
import { z } from 'zod';

import { readModelRoutes } from './model-routes.js';
import { readPlanStore } from './plans.js';
import { readPoolPlanLinks } from './pool-plan-links.js';
import {
  queryActiveSessionsPerTarget,
  queryAttemptCountsPerTarget,
  resolveOpenCodeDbPath,
} from './model-route-stats.js';

const STATS_ERROR_CODES = new Set(['no-database', 'no-tables', 'no-sqlite']);

// A pool target is `provider/model[#variant]` or `{ model, ... }`; the reference drops the variant.
const targetRefSchema = z.union([z.string(), z.object({ model: z.string() }).transform((target) => target.model)]);

/** The target's `provider/model` reference, with any pattern wildcard left as-is, or '' for a malformed entry. */
const targetRef = (target) => (targetRefSchema.safeParse(target).data ?? '').split('#')[0];

const WARN_RATIO = 0.7;

// Which recent-usage figure a quota unit is measured in. `tokens` is input,
// output and reasoning together, the figure OpenCode meters plans by
// (`packages/core/src/model-usage.ts`). Cost and percent windows need prices
// or the provider's own meter, so they get no projection.
const USAGE_BY_UNIT = { requests: 'attempts', messages: 'attempts', tokens: 'tokens' };

const projectionFor = (quota, usage, hours) => {
  const measure = USAGE_BY_UNIT[quota?.unit];
  if (!measure || quota.limit === undefined || quota.windowHours === undefined || !(quota.limit > 0)) return null;
  const projected = (usage[measure] / hours) * quota.windowHours;
  const ratio = projected / quota.limit;
  return {
    quotaName: quota.name,
    unit: quota.unit,
    limit: quota.limit,
    windowHours: quota.windowHours,
    projected: Math.round(projected * 10) / 10,
    ratio,
    status: ratio >= 1 ? 'over' : ratio >= WARN_RATIO ? 'warn' : 'ok',
  };
};

/** The plan's tightest window: the projection closest to (or furthest past) its limit. */
const tightestProjection = (quotas, usage, hours) =>
  quotas
    .map((quota) => projectionFor(quota, usage, hours))
    .filter(Boolean)
    .reduce((worst, next) => (worst === null || next.ratio > worst.ratio ? next : worst), null);

const positiveOr = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

export const computePoolHealth = async ({
  readConfigLayers,
  openchamberDataDir,
  resolveDbPath = resolveOpenCodeDbPath,
  loadPlanStore = readPlanStore,
  loadPoolPlanLinks = readPoolPlanLinks,
  hours: requestedHours,
  activeMinutes: requestedActiveMinutes,
  now = Date.now(),
} = {}) => {
  const hours = Math.min(336, positiveOr(requestedHours, 24));
  const activeMinutes = Math.min(1440, positiveOr(requestedActiveMinutes, 15));
  const layers = readConfigLayers(null);
  const routes = readModelRoutes(layers.mergedConfig);
  const planStore = loadPlanStore();
  const links = loadPoolPlanLinks(openchamberDataDir).links;
  const planByID = new Map(planStore.plans.map((plan) => [plan.id, plan]));

  let activeByRef = new Map();
  let usageByRef = new Map();
  let statsAvailable = true;
  let statsReason;
  try {
    const dbPath = resolveDbPath();
    const [active, usage] = await Promise.all([
      queryActiveSessionsPerTarget(dbPath, { minutes: activeMinutes, now }),
      queryAttemptCountsPerTarget(dbPath, { hours, now }),
    ]);
    activeByRef = new Map(active.targets.map((row) => [`${row.providerID}/${row.modelID}`, row.activeSessions]));
    usageByRef = new Map(usage.targets.map((row) => [`${row.providerID}/${row.modelID}`, { attempts: row.attempts, tokens: row.tokens }]));
  } catch (error) {
    statsAvailable = false;
    statsReason = STATS_ERROR_CODES.has(error?.code) ? error.code : 'unknown';
  }

  // Targets sharing one plan id pool their recent usage, so a quota ratio
  // reflects the plan's combined traffic, not one target's slice of it.
  const usageForPlan = (planID) => {
    const total = { attempts: 0, tokens: 0 };
    for (const [ref, planLinkID] of Object.entries(links)) {
      if (planLinkID !== planID) continue;
      const usage = usageByRef.get(ref);
      total.attempts += usage?.attempts ?? 0;
      total.tokens += usage?.tokens ?? 0;
    }
    return total;
  };

  const pools = {};
  for (const [poolID, route] of Object.entries(routes)) {
    const selection = route.selection ?? 'ordered';
    const targets = (route.targets ?? []).map((target) => {
      const ref = targetRef(target);
      const activeSessions = statsAvailable ? activeByRef.get(ref) ?? 0 : null;
      const planID = links[ref];
      const plan = planID ? planByID.get(planID) : undefined;
      const projection = statsAvailable && plan ? tightestProjection(plan.quotas, usageForPlan(planID), hours) : null;
      const planInfo = plan
        ? {
            id: plan.id,
            label: plan.label,
            providerID: plan.providerID,
            siblingRefs: Object.entries(links).filter(([, id]) => id === planID).map(([key]) => key).filter((key) => key !== ref),
            projection,
          }
        : null;
      const blastRadius = activeSessions !== null && activeSessions >= 2;
      const suggestion = projection && ['weighted', 'round-robin'].includes(selection) && (route.targets?.length ?? 0) > 1 && projection.status !== 'ok'
        ? 'lower-weight'
        : null;
      return { ref, activeSessions, plan: planInfo, blastRadius, suggestion };
    });
    pools[poolID] = { selection, targets };
  }

  return { available: true, statsAvailable, statsReason, generatedAt: now, pools };
};

export const registerPoolHealthRoutes = (app, dependencies) => {
  const { readConfigLayers, openchamberDataDir } = dependencies;

  app.get('/api/model-routes/health', async (req, res) => {
    try {
      res.json(
        await computePoolHealth({
          readConfigLayers,
          openchamberDataDir,
          hours: req.query?.hours ? Number(req.query.hours) : undefined,
          activeMinutes: req.query?.activeMinutes ? Number(req.query.activeMinutes) : undefined,
        }),
      );
    } catch (error) {
      res.status(error?.status ?? 500).json({ error: error?.message ?? 'Failed to compute pool health' });
    }
  });
};
