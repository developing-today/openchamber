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
const SELECTION_MODES = ["ordered", "round-robin", "weighted"];

const ROUTE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const TARGET_PATTERN = /^[^/#]+\/[^#]+(?:#[^#]+)?$/;

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isWhole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const MAX_MS = 3_600_000;
const MAX_COUNT = 50;

// The keys each object may carry, as OpenCode's schema defines them. OpenCode
// reads only these, so any other key would be saved and silently ignored.
// `description` and `details` are the exception: OpenChamber owns them and
// gives them to Jev (`jev.js`). OpenCode decodes its config with
// `onExcessProperty: "ignore"` (core config.ts, config/normalize.ts), so it
// loads a route that carries them and drops the two keys.
const ROUTE_KEYS = ["name", "targets", "health", "budgets", "hedgeAfterMs", "attempts", "autonomy", "selection", "weights", "description", "details"];
// The UI reads a value over these as absent (`modelRoutesApi.ts`), so the two
// must match; `model-routes.test.js` checks that.
export const MAX_DESCRIPTION_LENGTH = 200;
export const MAX_DETAILS_LENGTH = 2000;
const TARGET_KEYS = ["model", "defaultVariant", "variants", "until"];
const HEALTH_KEYS = ["firstTokenTimeoutMs", "maxResponseTimeMs", "minOutputTokensPerSecond", "sampleWindow", "slowThreshold", "cooldownMs", "quotaCooldownMs"];
const BUDGET_KEYS = ["requestsPerMinute", "requestsPerDay", "tokensPerMinute", "tokensPerDay", "softLimit"];
const TUNING_KEYS = ["enabled", "intervalMinutes", "windowHours", "notes"];

// OpenCode's defaults for the health window (model-route.ts).
const DEFAULT_SAMPLE_WINDOW = 5;
const DEFAULT_SLOW_THRESHOLD = 3;

/** Names the keys of `value` that the schema does not define, or null. */
const unknownKeysProblem = (value, allowed) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return null;
  const noun = unknown.length === 1 ? "key" : "keys";
  return `unknown ${noun} ${unknown.map((key) => `"${key}"`).join(", ")} (expected ${allowed.join(", ")})`;
};

/** The raw `experimental.model_routes` map from a merged OpenCode config, or {}. */
export const readModelRoutes = (config) => {
  const routes = config?.experimental?.model_routes;
  return isRecord(routes) ? routes : {};
};

/**
 * The pools OpenCode builds from every config file it reads (`sources` from
 * `readConfigSources`, lowest priority first). A later file's pool replaces an
 * earlier one of the same id whole, as OpenCode's model-routes config plugin
 * does (`routes.set(id, route)`), so a pool's description comes from the same
 * file as its targets. A file that failed to parse reads as empty and adds nothing.
 */
export const readLayeredModelRoutes = (sources) => {
  const routes = {};
  for (const source of sources) Object.assign(routes, readModelRoutes(source.config));
  return routes;
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
  const unknown = unknownKeysProblem(health, HEALTH_KEYS);
  if (unknown) return `route "${id}" health has ${unknown}`;
  for (const [key, max] of Object.entries(HEALTH_LIMITS)) {
    const value = health[key];
    if (value === undefined) continue;
    if (key === "firstTokenTimeoutMs" && value === false) continue;
    if (!isWhole(value, 1, max)) return `route "${id}" health.${key} must be a whole number from 1 to ${max}`;
  }
  if (health.minOutputTokensPerSecond !== undefined && !(typeof health.minOutputTokensPerSecond === "number" && health.minOutputTokensPerSecond > 0))
    return `route "${id}" health.minOutputTokensPerSecond must be a positive number`;
  // OpenCode clamps slowThreshold to the window without saying so; a window
  // that cannot hold that many slow requests is refused instead.
  const windowSize = health.sampleWindow ?? DEFAULT_SAMPLE_WINDOW;
  const slowCount = health.slowThreshold ?? DEFAULT_SLOW_THRESHOLD;
  if (slowCount > windowSize)
    return `route "${id}" health.slowThreshold (${slowCount}) cannot exceed health.sampleWindow (${windowSize}): the window could never hold that many slow requests`;
  return null;
};

const BUDGET_LIMITS = ["requestsPerMinute", "requestsPerDay", "tokensPerMinute", "tokensPerDay"];

const validateBudgets = (id, budgets) => {
  if (!isRecord(budgets)) return `route "${id}" budgets must map target references to allowances`;
  for (const [target, budget] of Object.entries(budgets)) {
    if (!isRecord(budget)) return `route "${id}" budget for "${target}" must be an object`;
    const unknown = unknownKeysProblem(budget, BUDGET_KEYS);
    if (unknown) return `route "${id}" budget for "${target}" has ${unknown}`;
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
  const unknown = unknownKeysProblem(target, TARGET_KEYS);
  if (unknown) return unknown;
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

// A weight or budget key names a target by its reference: the model with any
// `#variant` removed (core keys them that way). A `*` target also covers the
// concrete models it matches, so those keys are accepted too.
const referenceOf = (target) => (target.model ?? target).split("#")[0];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const keyNamesTarget = (key, target) => {
  const reference = referenceOf(target);
  if (key === reference) return true;
  if (!reference.includes("*")) return false;
  const [provider, ...pattern] = reference.split("/");
  const [keyProvider, ...model] = key.split("/");
  if (provider !== keyProvider || model.length === 0) return false;
  const matcher = new RegExp(`^${pattern.join("/").split("*").map(escapeRegExp).join(".*")}$`);
  return matcher.test(model.join("/"));
};

export const validateModelRoute = (id, route) => {
  if (!ROUTE_ID_PATTERN.test(id)) return `invalid route id "${id}"`;
  if (!isRecord(route)) return `route "${id}" must be an object`;
  const unknown = unknownKeysProblem(route, ROUTE_KEYS);
  if (unknown) return `route "${id}" has ${unknown}`;
  if (route.name !== undefined && typeof route.name !== "string") return `route "${id}" name must be a string`;
  // Only a string is equal to its own String(), so these are plain value checks.
  if (route.description !== undefined) {
    if (String(route.description) !== route.description || /[\r\n]/.test(route.description))
      return `route "${id}" description must be one line of text`;
    if (route.description.length > MAX_DESCRIPTION_LENGTH)
      return `route "${id}" description must be at most ${MAX_DESCRIPTION_LENGTH} characters`;
  }
  if (route.details !== undefined) {
    if (String(route.details) !== route.details) return `route "${id}" details must be text`;
    if (route.details.length > MAX_DETAILS_LENGTH)
      return `route "${id}" details must be at most ${MAX_DETAILS_LENGTH} characters`;
  }
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
  // OpenCode keeps a fixed route in its configured order, so a selection mode there would be ignored.
  if (route.autonomy === "fixed" && route.selection !== undefined && route.selection !== "ordered")
    return `route "${id}" is fixed, so it keeps its configured order; selection "${route.selection}" needs autonomy rules or higher`;
  if (route.weights !== undefined) {
    if (!isRecord(route.weights)) return `route "${id}" weights must map target references to numbers`;
    for (const [key, weight] of Object.entries(route.weights)) {
      if (typeof weight !== "number" || !(weight > 0))
        return `route "${id}" weight for "${key}" must be a positive number`;
      if (!route.targets.some((target) => keyNamesTarget(key, target)))
        return `route "${id}" weight for "${key}" matches no target in the route`;
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

// The shape OpenCode's schema accepts for one note (`NOTE_LINE`, packages/schema/src/config/model-routes.ts):
// one line of `match: text`, with a non-space character before its first colon (never a colon) and after it.
const NOTE_LINE = /^[^:\r\n]*[^\s:][^:\r\n]*:[^\r\n]*\S[^\r\n]*$/;

export const validateModelRouteTuning = (tuning) => {
  if (!isRecord(tuning)) return "tuning must be an object";
  const unknown = unknownKeysProblem(tuning, TUNING_KEYS);
  if (unknown) return `tuning has ${unknown}`;
  if (tuning.enabled !== undefined && typeof tuning.enabled !== "boolean") return "tuning.enabled must be true or false";
  if (tuning.intervalMinutes !== undefined && !isWhole(tuning.intervalMinutes, 1, 1440))
    return "tuning.intervalMinutes must be a whole number from 1 to 1440";
  if (tuning.windowHours !== undefined && !isWhole(tuning.windowHours, 1, 336))
    return "tuning.windowHours must be a whole number from 1 to 336";
  if (tuning.notes !== undefined) {
    // Only a string is equal to its own String(), so this is a plain value check.
    if (!Array.isArray(tuning.notes) || !tuning.notes.every((line) => String(line) === line))
      return "tuning.notes must be a list of strings";
    const bad = tuning.notes.findIndex((line) => !NOTE_LINE.test(line));
    if (bad !== -1) return `tuning.notes line ${bad + 1} must read "match: text" on one line`;
  }
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
