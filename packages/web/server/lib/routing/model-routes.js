import { isDeepStrictEqual } from 'node:util';
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
// The object form of a model selection in OpenCode's schema
// (packages/schema/src/config/model.ts): a provider id without / or #, and a
// model and variant id without #.
const SELECTION_PROVIDER_PATTERN = /^[^/#]+$/;
const SELECTION_ID_PATTERN = /^[^#]+$/;

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isWhole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
// Only a string is equal to its own String(), so this is a plain value check.
const isString = (value) => String(value) === value;
const MAX_MS = 3_600_000;
const MAX_COUNT = 50;

// The keys each object may carry, as OpenCode's schema defines them in
// packages/schema/src/config/model-routes.ts (Route, the object form of Target,
// Health, Budget, Schedule, Window and Tuning). OpenCode drops any other key
// and loads the rest, so a pool that carries one is flagged. Keep these in step
// with that file: a key missing here flags every pool that uses it.
const ROUTE_KEYS = ["name", "targets", "health", "budgets", "hedgeAfterMs", "attempts", "autonomy", "selection", "weights", "schedules"];
const TARGET_KEYS = ["model", "defaultVariant", "variants", "until"];
const SELECTION_KEYS = ["providerID", "model", "variant"];
const HEALTH_KEYS = ["firstTokenTimeoutMs", "maxResponseTimeMs", "minOutputTokensPerSecond", "sampleWindow", "slowThreshold", "cooldownMs", "quotaCooldownMs"];
const BUDGET_KEYS = ["requestsPerMinute", "requestsPerDay", "tokensPerMinute", "tokensPerDay", "softLimit"];
const SCHEDULE_KEYS = ["id", "targets", "when", "factor", "weight", "note"];
const WINDOW_KEYS = ["daysOfWeek", "daysOfMonth", "start", "end", "timezone", "from", "until"];
const TUNING_KEYS = ["enabled", "intervalMinutes", "windowHours", "notes"];

// OpenCode's defaults for the health window (model-route.ts).
const DEFAULT_SAMPLE_WINDOW = 5;
const DEFAULT_SLOW_THRESHOLD = 3;

// Every problem says whether OpenCode refuses the same value. OpenCode decodes
// each pool on its own and leaves out one that fails its schema
// (packages/core/src/config/normalize.ts, `decodeMap`), so a `skipsPool`
// problem means OpenCode runs without that pool. The other problems are
// OpenChamber's stricter checks of what OpenCode loads anyway: it drops an
// unknown key, clamps the slow threshold to the window, ignores a weight
// without a target and a fixed pool's selection, offers a pool with no targets
// as no model, and reads a `{ providerID, model }` target OpenChamber does not check.
const poolSkipped = (message) => ({ message, skipsPool: true });
const poolFlagged = (message) => ({ message, skipsPool: false });

/** The same problems, each message led by where it was found. */
const within = (prefix, problems) => problems.map(({ message, skipsPool }) => ({ message: `${prefix}${message}`, skipsPool }));

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
  if (!isRecord(health)) return [poolSkipped(`route "${id}" health must be an object`)];
  const problems = [];
  const unknown = unknownKeysProblem(health, HEALTH_KEYS);
  if (unknown) problems.push(poolFlagged(`route "${id}" health has ${unknown}`));
  for (const [key, max] of Object.entries(HEALTH_LIMITS)) {
    const value = health[key];
    if (value === undefined || (key === "firstTokenTimeoutMs" && value === false)) continue;
    if (!isWhole(value, 1, max)) problems.push(poolSkipped(`route "${id}" health.${key} must be a whole number from 1 to ${max}`));
  }
  // OpenCode's schema wants a finite rate, so Infinity drops the pool.
  const rate = health.minOutputTokensPerSecond;
  if (rate !== undefined && !(Number.isFinite(rate) && rate > 0))
    problems.push(poolSkipped(`route "${id}" health.minOutputTokensPerSecond must be a positive number`));
  // OpenCode clamps slowThreshold to the window without saying so; a window
  // that cannot hold that many slow requests is flagged instead.
  const windowSize = health.sampleWindow ?? DEFAULT_SAMPLE_WINDOW;
  const slowCount = health.slowThreshold ?? DEFAULT_SLOW_THRESHOLD;
  if (isWhole(windowSize, 1, MAX_COUNT) && isWhole(slowCount, 1, MAX_COUNT) && slowCount > windowSize)
    problems.push(poolFlagged(`route "${id}" health.slowThreshold (${slowCount}) cannot exceed health.sampleWindow (${windowSize}): the window could never hold that many slow requests`));
  return problems;
};

const BUDGET_LIMITS = ["requestsPerMinute", "requestsPerDay", "tokensPerMinute", "tokensPerDay"];

const validateBudgets = (id, budgets) => {
  if (!isRecord(budgets)) return [poolSkipped(`route "${id}" budgets must map target references to allowances`)];
  return Object.entries(budgets).flatMap(([target, budget]) => {
    if (!isRecord(budget)) return [poolSkipped(`route "${id}" budget for "${target}" must be an object`)];
    const problems = [];
    const unknown = unknownKeysProblem(budget, BUDGET_KEYS);
    if (unknown) problems.push(poolFlagged(`route "${id}" budget for "${target}" has ${unknown}`));
    for (const key of BUDGET_LIMITS) {
      if (budget[key] !== undefined && !isWhole(budget[key], 1, Number.MAX_SAFE_INTEGER))
        problems.push(poolSkipped(`route "${id}" budget for "${target}" ${key} must be a positive whole number`));
    }
    if (budget.softLimit !== undefined && !(typeof budget.softLimit === "number" && budget.softLimit >= 0.125 && budget.softLimit <= 1))
      problems.push(poolSkipped(`route "${id}" budget for "${target}" softLimit must be between 0.125 and 1`));
    return problems;
  });
};

// The day names OpenCode's schema accepts (`DayOfWeek`), lowercase only.
const DAY_NAMES = ["sun", "sunday", "mon", "monday", "tue", "tuesday", "tues", "wed", "wednesday", "thu", "thursday", "thur", "thurs", "fri", "friday", "sat", "saturday"];
const isDayOfWeek = (day) => DAY_NAMES.includes(day) || isWhole(day, 0, 6);
const isDayOfMonth = (day) => day === -1 || isWhole(day, 1, 31);

/**
 * A schedule's `when` window, checked only as far as OpenCode's schema checks
 * it. Start, end and timezone may be any string there. OpenCode skips a
 * schedule whose window it cannot read, and still loads the config.
 */
const validateWindow = (when) => {
  if (!isRecord(when)) return [poolSkipped("when must be an object")];
  const problems = [];
  const unknown = unknownKeysProblem(when, WINDOW_KEYS);
  if (unknown) problems.push(poolFlagged(`when has ${unknown}`));
  if (when.daysOfWeek !== undefined && !(Array.isArray(when.daysOfWeek) && when.daysOfWeek.every(isDayOfWeek)))
    problems.push(poolSkipped("when.daysOfWeek must list lowercase day names such as mon or monday, or numbers from 0 (Sunday) to 6 (Saturday)"));
  if (when.daysOfMonth !== undefined && !(Array.isArray(when.daysOfMonth) && when.daysOfMonth.every(isDayOfMonth)))
    problems.push(poolSkipped("when.daysOfMonth must list whole numbers from 1 to 31, or -1 for the last day"));
  for (const key of ["start", "end", "timezone"])
    if (when[key] !== undefined && !isString(when[key])) problems.push(poolSkipped(`when.${key} must be a string`));
  for (const key of ["from", "until"])
    if (when[key] !== undefined && !isWhole(when[key], 1, Number.MAX_SAFE_INTEGER))
      problems.push(poolSkipped(`when.${key} must be a positive epoch-millisecond time`));
  return problems;
};

/**
 * One entry of a route's `schedules`. OpenCode's description asks for exactly
 * one of factor and weight, but its schema also takes both (weight wins) or
 * neither (the entry changes nothing), and so does this check.
 */
const validateSchedule = (schedule) => {
  if (!isRecord(schedule)) return [poolSkipped("must be an object")];
  const problems = [];
  const unknown = unknownKeysProblem(schedule, SCHEDULE_KEYS);
  if (unknown) problems.push(poolFlagged(`has ${unknown}`));
  if (schedule.id !== undefined && !isString(schedule.id)) problems.push(poolSkipped("id must be a string"));
  if (schedule.targets !== undefined && !(Array.isArray(schedule.targets) && schedule.targets.every(isString)))
    problems.push(poolSkipped("targets must be a list of strings"));
  if (schedule.when === undefined) problems.push(poolSkipped("needs a when window"));
  else problems.push(...validateWindow(schedule.when));
  for (const key of ["factor", "weight"])
    if (schedule[key] !== undefined && !(Number.isFinite(schedule[key]) && schedule[key] > 0))
      problems.push(poolSkipped(`${key} must be a positive number`));
  if (schedule.note !== undefined && !isString(schedule.note)) problems.push(poolSkipped("note must be a string"));
  return problems;
};

const validateSchedules = (id, schedules) => {
  if (!Array.isArray(schedules)) return [poolSkipped(`route "${id}" schedules must be a list`)];
  return schedules.flatMap((schedule, index) => within(`route "${id}" schedule ${index + 1} `, validateSchedule(schedule)));
};

/** Whether OpenCode reads `value` as the object form of a model selection, `{ providerID, model, variant }`. */
const isSelectionObject = (value) =>
  isRecord(value)
  && isString(value.providerID) && SELECTION_PROVIDER_PATTERN.test(value.providerID)
  && isString(value.model) && SELECTION_ID_PATTERN.test(value.model)
  && (value.variant === undefined || (isString(value.variant) && SELECTION_ID_PATTERN.test(value.variant)));

// OpenCode drops any other key on a selection, such as an `until` written next to providerID.
const selectionProblems = (selection) => {
  const problems = [poolFlagged(`target "${selection.providerID}/${selection.model}" is written as { providerID, model }, which OpenChamber does not check`)];
  const unknown = unknownKeysProblem(selection, SELECTION_KEYS);
  if (unknown) problems.push(poolFlagged(`has a bad target: ${unknown}`));
  return problems;
};

/**
 * A single target: a `provider/model` string, a `{ providerID, model }`
 * selection, or `{ model, ... }` with variant overrides. The messages follow
 * `route "<id>" `.
 */
const validateTarget = (target) => {
  if (typeof target === "string") return TARGET_PATTERN.test(target) ? [] : [poolSkipped("has a bad target: must look like provider/model")];
  // OpenCode reads an object as a selection first, and as `{ model, ... }` only when that fails.
  if (isSelectionObject(target)) return selectionProblems(target);
  if (!isRecord(target)) return [poolSkipped("has a bad target: must be a provider/model string or an object with a model field")];
  const problems = [];
  const unknown = unknownKeysProblem(target, TARGET_KEYS);
  if (unknown) problems.push(poolFlagged(`has a bad target: ${unknown}`));
  if (isSelectionObject(target.model)) problems.push(...selectionProblems(target.model));
  else if (typeof target.model !== "string" || !TARGET_PATTERN.test(target.model))
    problems.push(poolSkipped("has a bad target: its model must look like provider/model"));
  // OpenCode wants a safe integer, so a time past Number.MAX_SAFE_INTEGER drops the pool.
  if (target.until !== undefined && !isWhole(target.until, 1, Number.MAX_SAFE_INTEGER))
    problems.push(poolSkipped("has a bad target: its until must be a positive epoch-millisecond time"));
  if (target.defaultVariant !== undefined && typeof target.defaultVariant !== "string")
    problems.push(poolSkipped("has a bad target: its defaultVariant must be a string"));
  if (target.variants !== undefined) {
    if (!isRecord(target.variants)) problems.push(poolSkipped("has a bad target: its variants must map route variants to target variants"));
    else for (const [from, to] of Object.entries(target.variants))
      if (typeof to !== "string") problems.push(poolSkipped(`has a bad target: its variant remap "${from}" must be a string`));
  }
  return problems;
};

// A weight or budget key names a target by its reference: provider/model with
// any `#variant` removed (core keys them that way). A `*` target also covers
// the concrete models it matches, so those keys are accepted too. Null for a
// target that names no model this module can read.
const referenceOf = (target) => {
  const selection = isRecord(target) && !isSelectionObject(target) ? target.model : target;
  if (isSelectionObject(selection)) return `${selection.providerID}/${selection.model}`;
  return isString(selection) ? selection.split("#")[0] : null;
};
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const keyNamesTarget = (key, target) => {
  const reference = referenceOf(target);
  if (reference === null) return false;
  if (key === reference) return true;
  if (!reference.includes("*")) return false;
  const [provider, ...pattern] = reference.split("/");
  const [keyProvider, ...model] = key.split("/");
  if (provider !== keyProvider || model.length === 0) return false;
  const matcher = new RegExp(`^${pattern.join("/").split("*").map(escapeRegExp).join(".*")}$`);
  return matcher.test(model.join("/"));
};

// OpenCode's schema wants finite positive weights, so Infinity drops the pool.
const validateWeights = (id, weights, targets) => {
  if (!isRecord(weights)) return [poolSkipped(`route "${id}" weights must map target references to numbers`)];
  return Object.entries(weights).flatMap(([key, weight]) => {
    if (!(Number.isFinite(weight) && weight > 0)) return [poolSkipped(`route "${id}" weight for "${key}" must be a positive number`)];
    if (targets !== null && !targets.some((target) => keyNamesTarget(key, target)))
      return [poolFlagged(`route "${id}" weight for "${key}" matches no target in the route`)];
    return [];
  });
};

/** Every problem OpenChamber finds in one pool, in the order it checks them; empty when there is none. */
export const modelRouteProblems = (id, route) => {
  const problems = [];
  if (!ROUTE_ID_PATTERN.test(id)) problems.push(poolSkipped(`invalid route id "${id}"`));
  if (!isRecord(route)) return [...problems, poolSkipped(`route "${id}" must be an object`)];
  const unknown = unknownKeysProblem(route, ROUTE_KEYS);
  if (unknown) problems.push(poolFlagged(`route "${id}" has ${unknown}`));
  if (route.name !== undefined && typeof route.name !== "string") problems.push(poolSkipped(`route "${id}" name must be a string`));
  const targets = Array.isArray(route.targets) ? route.targets : null;
  if (targets === null) problems.push(poolSkipped(`route "${id}" needs at least one target`));
  // OpenCode loads a pool with an empty list and offers it as no model.
  else if (targets.length === 0) problems.push(poolFlagged(`route "${id}" needs at least one target`));
  for (const target of targets ?? []) problems.push(...within(`route "${id}" `, validateTarget(target)));
  if (route.autonomy !== undefined && !AUTONOMY_LEVELS.includes(route.autonomy))
    problems.push(poolSkipped(`route "${id}" has unknown autonomy "${route.autonomy}" (expected ${AUTONOMY_LEVELS.join(", ")})`));
  if (route.selection !== undefined && !SELECTION_MODES.includes(route.selection))
    problems.push(poolSkipped(`route "${id}" has unknown selection "${route.selection}" (expected ${SELECTION_MODES.join(", ")})`));
  // OpenCode keeps a fixed route in its configured order, so a selection mode there would be ignored.
  else if (route.autonomy === "fixed" && route.selection !== undefined && route.selection !== "ordered")
    problems.push(poolFlagged(`route "${id}" is fixed, so it keeps its configured order; selection "${route.selection}" needs autonomy rules or higher`));
  if (route.weights !== undefined) problems.push(...validateWeights(id, route.weights, targets));
  if (route.attempts !== undefined && !isWhole(route.attempts, 1, MAX_COUNT))
    problems.push(poolSkipped(`route "${id}" attempts must be a whole number from 1 to ${MAX_COUNT}`));
  if (route.hedgeAfterMs !== undefined && !isWhole(route.hedgeAfterMs, 1, MAX_MS))
    problems.push(poolSkipped(`route "${id}" hedgeAfterMs must be a whole number from 1 to ${MAX_MS}`));
  if (route.health !== undefined) problems.push(...validateHealth(id, route.health));
  if (route.budgets !== undefined) problems.push(...validateBudgets(id, route.budgets));
  if (route.schedules !== undefined) problems.push(...validateSchedules(id, route.schedules));
  return problems;
};

/** The problems of every pool that has any, keyed by pool id. */
export const modelRoutesProblems = (routes) =>
  Object.fromEntries(
    Object.entries(routes)
      .map(([id, route]) => [id, modelRouteProblems(id, route)])
      .filter(([, problems]) => problems.length > 0),
  );

/**
 * What a save writes, and the problems of the pools it adds or changes.
 *
 * Each pool sent is compared with the one the config holds now, as JSON,
 * because that is how the client received it: a value JSON cannot carry, such
 * as `1e999` read as Infinity, reached the client as null and comes back that
 * way. A pool that comes back unchanged is written exactly as the config holds
 * it and is not checked, so a pool nobody touched never blocks a save.
 */
export const reviewModelRoutesSave = (routes, saved) => {
  const entries = Object.entries(routes);
  const unchanged = new Set(
    entries
      .filter(([id, route]) => Object.hasOwn(saved, id) && isDeepStrictEqual(route, JSON.parse(JSON.stringify(saved[id]))))
      .map(([id]) => id),
  );
  return {
    routes: Object.fromEntries(entries.map(([id, route]) => [id, unchanged.has(id) ? saved[id] : route])),
    problems: modelRoutesProblems(Object.fromEntries(entries.filter(([id]) => !unchanged.has(id)))),
  };
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
    if (!Array.isArray(tuning.notes) || !tuning.notes.every(isString))
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

  // Problems never fail a read: each pool comes back with what the validator
  // finds, so Settings can warn on it.
  app.get("/api/model-routes", async (req, res) => {
    try {
      const layers = readConfigLayers(null);
      const routes = readModelRoutes(layers.mergedConfig);
      res.json({
        routes,
        tuning: readModelRouteTuning(layers.mergedConfig),
        path: layers.paths.userPath ?? CONFIG_FILE,
        problems: modelRoutesProblems(routes),
      });
    } catch (error) {
      res.status(500).json({ error: error?.message ?? "Failed to read model pools" });
    }
  });

  // Only the pools a save adds or changes are checked. When one of them has a
  // problem the save is refused with the problems per pool, unless `force` is
  // true; then it is written and the problems come back with the other warnings.
  app.put("/api/model-routes", express.json({ limit: "256kb" }), refuseInEnterpriseMode, async (req, res) => {
    try {
      const { routes, tuning, force } = req.body ?? {};
      if (routes === undefined && tuning === undefined)
        return res.status(400).json({ error: "Send routes, tuning, or both" });
      if (routes !== undefined && !isRecord(routes))
        return res.status(400).json({ error: "routes must be an object of route definitions" });
      if (tuning !== undefined && tuning !== null) {
        const problem = validateModelRouteTuning(tuning);
        if (problem) return res.status(400).json({ error: problem });
      }
      const layers = readConfigLayers(null);
      const review = routes === undefined ? null : reviewModelRoutesSave(routes, readModelRoutes(layers.mergedConfig));
      const refused = Object.values(review?.problems ?? {}).flat();
      if (refused.length > 0 && force !== true)
        return res.status(400).json({ error: refused.map(({ message }) => message).join("; "), problems: review.problems });
      const targetPath = layers.paths.userPath ?? CONFIG_FILE;
      const targetConfig = getConfigForPath(layers, targetPath);
      if (!isRecord(targetConfig.experimental)) targetConfig.experimental = {};
      if (review) targetConfig.experimental.model_routes = review.routes;
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
      const savedRoutes = review?.routes ?? readModelRoutes(layers.mergedConfig);
      res.json({
        routes: savedRoutes,
        tuning: tuning === undefined ? readModelRouteTuning(layers.mergedConfig) : tuning,
        path: targetPath,
        problems: modelRoutesProblems(savedRoutes),
      });
    } catch (error) {
      res.status(500).json({ error: error?.message ?? "Failed to save model pools" });
    }
  });
};
