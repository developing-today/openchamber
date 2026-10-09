import express from 'express';

/**
 * Model pools for OpenCode's `experimental.model_routes`: ordered provider/model
 * targets behind one `opencode-route/<id>` name, each with its own autonomy level.
 *
 * OpenChamber owns the Jev category decision (which kind of task this is);
 * OpenCode owns provider failover inside the chosen pool. This module is the
 * bridge: it reads the merged OpenCode config and writes route definitions to
 * the user's global `opencode.json(c)`, the same file the providers surface
 * writes to. Writes are refused in enterprise mode, where the administrator
 * controls the OpenCode config.
 */

export const AUTONOMY_LEVELS = ["fixed", "rules", "adaptive", "predictive", "agent"];
export const SELECTION_MODES = ["ordered", "round-robin", "weighted"];

const ROUTE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TARGET_PATTERN = /^[^/#]+\/[^#]+(?:#[^#]+)?$/;

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isWhole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const MAX_MS = 3_600_000;
const MAX_COUNT = 50;

/** The raw `experimental.model_routes` map from a merged OpenCode config, or {}. */
export const readModelRoutes = (config) => {
  const routes = config?.experimental?.model_routes;
  return isRecord(routes) ? routes : {};
};

const readModelRouteTuning = (config) => {
  const tuning = config?.experimental?.model_route_tuning;
  return isRecord(tuning) ? tuning : null;
};

const HEALTH_LIMITS = {
  firstTokenTimeoutMs: MAX_MS,
  maxResponseTimeMs: MAX_MS,
  cooldownMs: MAX_MS,
  quotaCooldownMs: MAX_MS,
  sampleWindow: MAX_COUNT,
  slowThreshold: MAX_COUNT,
};

const validateHealth = (id, health) => {
  if (!isRecord(health)) return `route "${id}" health must be an object`;
  for (const [key, max] of Object.entries(HEALTH_LIMITS)) {
    const value = health[key];
    if (value === undefined) continue;
    if (key === "firstTokenTimeoutMs" && value === false) continue;
    if (!isWhole(value, 1, max)) return `route "${id}" health.${key} must be a whole number from 1 to ${max}`;
  }
  if (health.minOutputTokensPerSecond !== undefined && !(typeof health.minOutputTokensPerSecond === "number" && health.minOutputTokensPerSecond > 0))
    return `route "${id}" health.minOutputTokensPerSecond must be a positive number`;
  return null;
};

const BUDGET_LIMITS = ["requestsPerMinute", "requestsPerDay", "tokensPerMinute", "tokensPerDay"];

const validateBudgets = (id, budgets) => {
  if (!isRecord(budgets)) return `route "${id}" budgets must map target references to allowances`;
  for (const [target, budget] of Object.entries(budgets)) {
    if (!isRecord(budget)) return `route "${id}" budget for "${target}" must be an object`;
    for (const key of BUDGET_LIMITS) {
      if (budget[key] !== undefined && !isWhole(budget[key], 1, Number.MAX_SAFE_INTEGER))
        return `route "${id}" budget for "${target}" ${key} must be a positive whole number`;
    }
    if (budget.softLimit !== undefined && !(typeof budget.softLimit === "number" && budget.softLimit >= 0.125 && budget.softLimit <= 1))
      return `route "${id}" budget for "${target}" softLimit must be between 0.125 and 1`;
  }
  return null;
};

/** A single target: a `provider/model` string or `{ model, ... }` with variant overrides. */
const validateTarget = (target) => {
  if (typeof target === "string") return TARGET_PATTERN.test(target) ? null : "must look like provider/model";
  if (!isRecord(target)) return "must be a provider/model string or an object with a model field";
  if (typeof target.model !== "string" || !TARGET_PATTERN.test(target.model))
    return "its model must look like provider/model";
  if (target.until !== undefined && !(Number.isInteger(target.until) && target.until > 0))
    return "its until must be a positive epoch-millisecond time";
  if (target.defaultVariant !== undefined && typeof target.defaultVariant !== "string")
    return "its defaultVariant must be a string";
  if (target.variants !== undefined) {
    if (!isRecord(target.variants)) return "its variants must map route variants to target variants";
    for (const [from, to] of Object.entries(target.variants))
      if (typeof to !== "string") return `its variant remap "${from}" must be a string`;
  }
  return null;
};

export const validateModelRoute = (id, route) => {
  if (!ROUTE_ID_PATTERN.test(id)) return `invalid route id "${id}"`;
  if (!isRecord(route)) return `route "${id}" must be an object`;
  if (route.name !== undefined && typeof route.name !== "string") return `route "${id}" name must be a string`;
  if (!Array.isArray(route.targets) || route.targets.length === 0)
    return `route "${id}" needs at least one target`;
  for (const target of route.targets) {
    const problem = validateTarget(target);
    if (problem) return `route "${id}" has a bad target: ${problem}`;
  }
  if (route.autonomy !== undefined && !AUTONOMY_LEVELS.includes(route.autonomy))
    return `route "${id}" has unknown autonomy "${route.autonomy}" (expected ${AUTONOMY_LEVELS.join(", ")})`;
  if (route.selection !== undefined && !SELECTION_MODES.includes(route.selection))
    return `route "${id}" has unknown selection "${route.selection}" (expected ${SELECTION_MODES.join(", ")})`;
  if (route.weights !== undefined) {
    if (!isRecord(route.weights)) return `route "${id}" weights must map target references to numbers`;
    for (const [key, weight] of Object.entries(route.weights)) {
      if (typeof weight !== "number" || !(weight > 0))
        return `route "${id}" weight for "${key}" must be a positive number`;
    }
  }
  if (route.attempts !== undefined && !isWhole(route.attempts, 1, MAX_COUNT))
    return `route "${id}" attempts must be a whole number from 1 to ${MAX_COUNT}`;
  if (route.hedgeAfterMs !== undefined && !isWhole(route.hedgeAfterMs, 1, MAX_MS))
    return `route "${id}" hedgeAfterMs must be a whole number from 1 to ${MAX_MS}`;
  if (route.health !== undefined) {
    const problem = validateHealth(id, route.health);
    if (problem) return problem;
  }
  if (route.budgets !== undefined) {
    const problem = validateBudgets(id, route.budgets);
    if (problem) return problem;
  }
  return null;
};

export const validateModelRoutes = (routes) => {
  if (!isRecord(routes)) return "routes must be an object of route definitions";
  for (const [id, route] of Object.entries(routes)) {
    const problem = validateModelRoute(id, route);
    if (problem) return problem;
  }
  return null;
};

export const validateModelRouteTuning = (tuning) => {
  if (!isRecord(tuning)) return "tuning must be an object";
  if (tuning.enabled !== undefined && typeof tuning.enabled !== "boolean") return "tuning.enabled must be true or false";
  if (tuning.intervalMinutes !== undefined && !isWhole(tuning.intervalMinutes, 1, 1440))
    return "tuning.intervalMinutes must be a whole number from 1 to 1440";
  if (tuning.windowHours !== undefined && !isWhole(tuning.windowHours, 1, 336))
    return "tuning.windowHours must be a whole number from 1 to 336";
  return null;
};

export const registerModelRouteRoutes = (app, dependencies) => {
  const {
    readConfigLayers,
    getConfigForPath,
    writeConfig,
    CONFIG_FILE,
    isEnterpriseMode,
    refreshOpenCodeAfterConfigChange,
  } = dependencies;

  const refuseInEnterpriseMode = (_req, res, next) =>
    isEnterpriseMode()
      ? res.status(403).json({ error: "Model pools are managed by the administrator in enterprise mode" })
      : next();

  app.get("/api/model-routes", async (req, res) => {
    try {
      const layers = readConfigLayers(null);
      res.json({
        routes: readModelRoutes(layers.mergedConfig),
        tuning: readModelRouteTuning(layers.mergedConfig),
        path: layers.paths.userPath ?? CONFIG_FILE,
      });
    } catch (error) {
      res.status(500).json({ error: error?.message ?? "Failed to read model pools" });
    }
  });

  app.put("/api/model-routes", express.json({ limit: "256kb" }), refuseInEnterpriseMode, async (req, res) => {
    try {
      const { routes, tuning } = req.body ?? {};
      if (routes === undefined && tuning === undefined)
        return res.status(400).json({ error: "Send routes, tuning, or both" });
      if (routes !== undefined) {
        const problem = validateModelRoutes(routes);
        if (problem) return res.status(400).json({ error: problem });
      }
      if (tuning !== undefined && tuning !== null) {
        const problem = validateModelRouteTuning(tuning);
        if (problem) return res.status(400).json({ error: problem });
      }
      const layers = readConfigLayers(null);
      const targetPath = layers.paths.userPath ?? CONFIG_FILE;
      const targetConfig = getConfigForPath(layers, targetPath);
      if (!isRecord(targetConfig.experimental)) targetConfig.experimental = {};
      if (routes !== undefined) targetConfig.experimental.model_routes = routes;
      if (tuning === null) delete targetConfig.experimental.model_route_tuning;
      else if (tuning !== undefined) targetConfig.experimental.model_route_tuning = tuning;
      writeConfig(targetConfig, targetPath);
      if (refreshOpenCodeAfterConfigChange) {
        try {
          await refreshOpenCodeAfterConfigChange("model-routes");
        } catch {
          // The file is written; a restart can pick it up later.
        }
      }
      res.json({
        routes: routes ?? readModelRoutes(layers.mergedConfig),
        tuning: tuning === undefined ? readModelRouteTuning(layers.mergedConfig) : tuning,
        path: targetPath,
      });
    } catch (error) {
      res.status(500).json({ error: error?.message ?? "Failed to save model pools" });
    }
  });
};
