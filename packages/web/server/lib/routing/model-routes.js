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
const ROUTE_KEYS = ["name", "targets", "health", "budgets", "hedgeAfterMs", "attempts", "autonomy", "selection", "weights", "schedules"];
const TARGET_KEYS = ["model", "defaultVariant", "variants", "until"];
const HEALTH_KEYS = ["firstTokenTimeoutMs", "maxResponseTimeMs", "minOutputTokensPerSecond", "sampleWindow", "slowThreshold", "cooldownMs", "quotaCooldownMs"];
const BUDGET_KEYS = ["requestsPerMinute", "requestsPerDay", "tokensPerMinute", "tokensPerDay", "softLimit"];
const TUNING_KEYS = ["enabled", "intervalMinutes", "windowHours", "notes"];
const SCHEDULE_KEYS = ["id", "targets", "when", "factor", "weight", "note"];
const WINDOW_KEYS = ["daysOfWeek", "daysOfMonth", "start", "end", "timezone", "from", "until"];
// The weekday spellings OpenCode's schema accepts, beside a whole number from 0 (Sunday) to 6.
const DAY_OF_WEEK_NAMES = [
  "sun", "sunday", "mon", "monday", "tue", "tuesday", "tues", "wed", "wednesday",
  "thu", "thursday", "thur", "thurs", "fri", "friday", "sat", "saturday",
];

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
  if (health.minOutputTokensPerSecond !== undefined && !isPositiveNumber(health.minOutputTokensPerSecond))
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

const validateBudgets = (id, budgets, targets) => {
  if (!isRecord(budgets)) return `route "${id}" budgets must map target references to allowances`;
  for (const [target, budget] of Object.entries(budgets)) {
    // OpenCode reads a budget by the concrete model a target expands to, so a
    // pattern key matches no leaf and the allowance would never apply.
    if (target.includes("*"))
      return `route "${id}" budget for "${target}" is keyed by a pattern: OpenCode reads budgets by concrete model reference, so key the budget by a concrete target instead`;
    // A route reference is not a leaf either: OpenCode looks budgets up only
    // by the concrete models a route expands to, never by `opencode-route/<id>`,
    // so a budget keyed by the reference would never apply. (Weights differ:
    // a nested route attaches under its `opencode-route/<id>` key, so a
    // weights key naming the reference is live configuration.)
    if (routeReferenceOf(target) !== null)
      return `route "${id}" budget for "${target}" is keyed by a route reference: OpenCode reads budgets by concrete model reference, so key the budget by a concrete model the route expands to instead`;
    if (!targets.some((candidate) => keyNamesTarget(target, candidate)))
      return `route "${id}" budget for "${target}" matches no target in the route`;
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

// Only a string is equal to its own String(), so this is a plain value check (the tuning-notes one).
const isString = (value) => String(value) === value;

const isPositiveNumber = (value) => Number.isFinite(value) && value > 0;

// A window time as OpenCode's schedule parser reads it (`minutesOf` in
// model-route-schedule.ts): "9:30", "09:30" or "9:30:15", hours to 23, minutes to 59.
// The parser compares minutes since midnight and rounds seconds down, so two
// spellings of one minute are the same time to it.
const windowTimeMinutes = (value) => {
  if (!isString(value)) return undefined;
  const match = /^(\d{1,2}):(\d{1,2})(?::\d{2})?$/.exec(value.trim());
  if (match === null || Number(match[1]) > 23 || Number(match[2]) > 59) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
};

const isWindowTime = (value) => windowTimeMinutes(value) !== undefined;

const isKnownTimezone = (value) => {
  if (!isString(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
};

/** A schedule's `when` window, judged the way OpenCode judges it: its schema first, then the
 * schedule parser, which drops a window it cannot read and takes the whole schedule with it. */
const validateScheduleWindow = (id, label, window) => {
  const unknown = unknownKeysProblem(window, WINDOW_KEYS);
  if (unknown) return `route "${id}" ${label} window has ${unknown}`;
  if (window.daysOfWeek !== undefined) {
    if (!Array.isArray(window.daysOfWeek))
      return `route "${id}" ${label} window.daysOfWeek must be a list of weekday names or whole numbers from 0 to 6`;
    if (window.daysOfWeek.length === 0)
      return `route "${id}" ${label} window.daysOfWeek must not be empty: OpenCode drops a schedule whose day list reads as empty, so leave the key out for every day`;
    for (const day of window.daysOfWeek)
      if (!DAY_OF_WEEK_NAMES.includes(day) && !isWhole(day, 0, 6))
        return `route "${id}" ${label} window.daysOfWeek entry "${String(day)}" is not a weekday name or a whole number from 0 to 6`;
  }
  if (window.daysOfMonth !== undefined) {
    if (!Array.isArray(window.daysOfMonth))
      return `route "${id}" ${label} window.daysOfMonth must be a list of whole numbers from 1 to 31, or -1 for the last day`;
    if (window.daysOfMonth.length === 0)
      return `route "${id}" ${label} window.daysOfMonth must not be empty: OpenCode drops a schedule whose day list reads as empty, so leave the key out for every day`;
    for (const day of window.daysOfMonth)
      if (day !== -1 && !isWhole(day, 1, 31))
        return `route "${id}" ${label} window.daysOfMonth entry "${String(day)}" is not a whole number from 1 to 31 or -1`;
  }
  for (const key of ["start", "end"])
    if (window[key] !== undefined && !isWindowTime(window[key]))
      return `route "${id}" ${label} window.${key} must be a local time like "09:00"`;
  if (
    window.start !== undefined &&
    window.end !== undefined &&
    windowTimeMinutes(window.start) === windowTimeMinutes(window.end)
  )
    return `route "${id}" ${label} window.start and window.end must not be the same time: OpenCode treats an equal start and end as an empty window that can never apply`;
  if (window.timezone !== undefined && !isKnownTimezone(window.timezone))
    return `route "${id}" ${label} window.timezone must be an IANA timezone name OpenCode can resolve`;
  for (const key of ["from", "until"])
    if (window[key] !== undefined && !isWhole(window[key], 1, Number.MAX_SAFE_INTEGER))
      return `route "${id}" ${label} window.${key} must be a positive epoch-millisecond time`;
  if (window.from !== undefined && window.until !== undefined && window.from >= window.until)
    return `route "${id}" ${label} window.from must be before window.until: OpenCode drops a window that can never apply`;
  // A window that has already ended can never apply again: OpenCode's
  // active() check is `now >= window.until` from the moment it passes.
  if (window.until !== undefined && window.until <= Date.now())
    return `route "${id}" ${label} window.until is in the past: the window has already ended, so the schedule can never apply`;
  return null;
};

/**
 * Whether two `*` patterns can match one reference at the same time. A star
 * takes any run of characters, so the patterns share a reference when their
 * fixed parts line up without a clash: `openai/gpt-*` and `openai/*-luna`
 * share `openai/gpt-6-luna`, while `openai/gpt-*` and `openai/claude-*` share
 * nothing. The walk visits pairs of pattern positions. A star either takes
 * no characters, which moves past it, or takes the character the other
 * pattern fixes next, which moves that pattern on.
 */
const patternsOverlap = (first, second) => {
  const seen = new Set();
  const stack = [[0, 0]];
  while (stack.length > 0) {
    const [i, j] = stack.pop();
    const key = `${i},${j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (i === first.length && j === second.length) return true;
    if (first[i] === "*") stack.push([i + 1, j]);
    if (second[j] === "*") stack.push([i, j + 1]);
    if (first[i] === "*" && j < second.length && second[j] !== "*") stack.push([i, j + 1]);
    else if (second[j] === "*" && i < first.length && first[i] !== "*") stack.push([i + 1, j]);
    else if (first[i] !== undefined && first[i] === second[j]) stack.push([i + 1, j + 1]);
  }
  return false;
};

/** A route's `schedules`: time-bound weight changes, as OpenCode's Schedule schema defines them.
 * A schedule with nothing to change, or with both changes, is refused: OpenCode drops the first
 * kind without a word and applies only the weight of the second, ignoring its factor. */
const validateSchedules = (id, schedules, targets) => {
  if (!Array.isArray(schedules)) return `route "${id}" schedules must be a list of schedule objects`;
  for (const [index, schedule] of schedules.entries()) {
    const label = `schedule ${index + 1}`;
    if (!isRecord(schedule)) return `route "${id}" ${label} must be an object`;
    const unknown = unknownKeysProblem(schedule, SCHEDULE_KEYS);
    if (unknown) return `route "${id}" ${label} has ${unknown}`;
    if (schedule.id !== undefined && !isString(schedule.id))
      return `route "${id}" ${label} id must be a string`;
    if (schedule.note !== undefined && !isString(schedule.note))
      return `route "${id}" ${label} note must be a string`;
    if (schedule.targets !== undefined) {
      if (!Array.isArray(schedule.targets) || schedule.targets.some((target) => !isString(target) || target.trim() === ""))
        return `route "${id}" ${label} targets must be a list of non-empty target references`;
      if (schedule.targets.length === 0)
        return `route "${id}" ${label} targets must not be empty: OpenCode applies a schedule with an empty targets list to every target in the route, so leave the key out for every target`;
      for (const entry of schedule.targets) {
        // OpenCode matches a schedule entry against a `provider/model`
        // reference, which carries no variant, so an entry spelled with the
        // `#variant` suffix targets use everywhere else can never match.
        if (entry.includes("#"))
          return `route "${id}" ${label} target "${entry}" carries a "#variant" suffix: OpenCode matches schedule targets against provider/model references without a variant, so the entry would never apply`;
        // OpenCode's schedule matcher is case-insensitive (its glob is built
        // with the `i` flag), so the entry and the targets are compared in
        // lower case: a case-only difference still applies there.
        const entryReference = referenceOf(entry).toLowerCase();
        const matches = targets.some((target) => {
          const targetReference = referenceOf(target).toLowerCase();
          if (keyNamesTarget(entryReference, targetReference) || keyNamesTarget(targetReference, entryReference)) return true;
          // Two patterns can cover a model together even when neither covers
          // the other, so a partly overlapping pair counts as a match too.
          return entryReference.includes("*") && targetReference.includes("*") && patternsOverlap(entryReference, targetReference);
        });
        if (!matches) return `route "${id}" ${label} target "${entry}" matches no target in the route`;
      }
    }
    if (!isRecord(schedule.when)) return `route "${id}" ${label} needs a when window object`;
    const windowProblem = validateScheduleWindow(id, label, schedule.when);
    if (windowProblem) return windowProblem;
    if (schedule.factor !== undefined && schedule.weight !== undefined)
      return `route "${id}" ${label} gives both factor and weight: OpenCode uses the weight and ignores the factor, so give one of them`;
    if (schedule.factor === undefined && schedule.weight === undefined)
      return `route "${id}" ${label} needs a factor or a weight: OpenCode drops a schedule with neither`;
    if (schedule.factor !== undefined && !isPositiveNumber(schedule.factor))
      return `route "${id}" ${label} factor must be a positive number`;
    if (schedule.weight !== undefined && !isPositiveNumber(schedule.weight))
      return `route "${id}" ${label} weight must be a positive number`;
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
  if (target.defaultVariant !== undefined && (typeof target.defaultVariant !== "string" || target.defaultVariant === ""))
    return "its defaultVariant must be a string and not empty: OpenCode drops an empty default variant, so the target would run at its own default";
  if (target.variants !== undefined) {
    if (!isRecord(target.variants)) return "its variants must map route variants to target variants";
    for (const [from, to] of Object.entries(target.variants)) {
      if (from === "") return "its variants must not use an empty route variant as a key: no selected variant is ever empty, so the remap would never apply";
      if (typeof to !== "string" || to === "") return `its variant remap "${from}" must be a string and not empty`;
    }
  }
  return null;
};

// A weight or budget key names a target by its reference: the model with any
// `#variant` removed (core keys them that way). A `*` target also covers the
// concrete models it matches, so those keys are accepted too.
const referenceOf = (target) => (target.model ?? target).split("#")[0];

const ROUTE_REFERENCE_PREFIX = "opencode-route/";

/** The route id a target references (`opencode-route/<id>`), or null for a model target. */
const routeReferenceOf = (target) => {
  const reference = referenceOf(target);
  return reference.startsWith(ROUTE_REFERENCE_PREFIX) ? reference.slice(ROUTE_REFERENCE_PREFIX.length) : null;
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a concrete `provider/model` key is the target or one its `*` pattern matches. */
export const keyNamesTarget = (key, target) => {
  const reference = referenceOf(target);
  if (key === reference) return true;
  if (!reference.includes("*")) return false;
  const [provider, ...pattern] = reference.split("/");
  const [keyProvider, ...model] = key.split("/");
  if (provider !== keyProvider || model.length === 0) return false;
  const matcher = new RegExp(`^${pattern.join("/").split("*").map(escapeRegExp).join(".*")}$`);
  return matcher.test(model.join("/"));
};

/**
 * The concrete targets a route expands to: its own model targets plus the
 * ones reached through the routes its targets reference, transitively.
 * OpenCode reads a route's budgets by the concrete model a target expands
 * to, collecting them from every route on the trail, so a set-level check
 * judges budget keys against this expanded set. The visited set keeps a
 * reference cycle from looping; a cycle contributes the concrete targets
 * its members name directly. Malformed targets are skipped here and
 * reported by the single-route validation.
 */
const expandedTargetsOf = (routes, id) => {
  const expanded = [];
  const visited = new Set();
  const walk = (routeId) => {
    if (visited.has(routeId)) return;
    visited.add(routeId);
    const route = routes[routeId];
    if (!isRecord(route) || !Array.isArray(route.targets)) return;
    for (const target of route.targets) {
      if (!isString(target) && !(isRecord(target) && isString(target.model))) continue;
      const referenced = routeReferenceOf(target);
      if (referenced === null) expanded.push(target);
      else walk(referenced);
    }
  };
  walk(id);
  return expanded;
};

export const validateModelRoute = (id, route, budgetTargets) => {
  if (!ROUTE_ID_PATTERN.test(id)) return `invalid route id "${id}"`;
  if (!isRecord(route)) return `route "${id}" must be an object`;
  const unknown = unknownKeysProblem(route, ROUTE_KEYS);
  if (unknown) return `route "${id}" has ${unknown}`;
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
  // OpenCode keeps a fixed route in its configured order, so a selection mode there would be ignored.
  if (route.autonomy === "fixed" && route.selection !== undefined && route.selection !== "ordered")
    return `route "${id}" is fixed, so it keeps its configured order; selection "${route.selection}" needs autonomy rules or higher`;
  // Weights and budgets are rules-level too: on a fixed route OpenCode replaces
  // every weight with 1 and never collects the budgets, so both would be ignored.
  if (route.autonomy === "fixed" && route.weights !== undefined)
    return `route "${id}" is fixed, so OpenCode ignores its weights; weights need autonomy rules or higher`;
  if (route.autonomy === "fixed" && route.budgets !== undefined)
    return `route "${id}" is fixed, so OpenCode ignores its budgets; budgets need autonomy rules or higher`;
  if (route.weights !== undefined) {
    if (!isRecord(route.weights)) return `route "${id}" weights must map target references to numbers`;
    for (const [key, weight] of Object.entries(route.weights)) {
      if (!isPositiveNumber(weight))
        return `route "${id}" weight for "${key}" must be a positive number`;
      // OpenCode reads a weight by the concrete key a target attaches with
      // (a leaf model or an `opencode-route/<id>` group), so a pattern key
      // matches no attach key and the weight would never apply.
      if (key.includes("*"))
        return `route "${id}" weight for "${key}" is keyed by a pattern: OpenCode reads weights by concrete target reference, so key the weight by a concrete target instead`;
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
    // The set-level caller passes the targets the route expands to through
    // its route references; a single route judged alone can only be judged
    // against its direct targets.
    const problem = validateBudgets(id, route.budgets, budgetTargets ?? route.targets);
    if (problem) return problem;
  }
  if (route.schedules !== undefined) {
    const problem = validateSchedules(id, route.schedules, route.targets);
    if (problem) return problem;
  }
  return null;
};

export const validateModelRoutes = (routes) => {
  if (!isRecord(routes)) return "routes must be an object of route definitions";
  for (const [id, route] of Object.entries(routes)) {
    const problem = validateModelRoute(id, route, expandedTargetsOf(routes, id));
    if (problem) return problem;
  }
  // A target can reference another route in the set (`opencode-route/<id>`).
  // OpenCode drops a reference it cannot visit — the named route is not in
  // the set, or it is already on the trail (a cycle) — without a word, so a
  // dead reference is refused here, the only place it can be named.
  for (const [id, route] of Object.entries(routes)) {
    for (const target of route.targets) {
      const referenced = routeReferenceOf(target);
      if (referenced !== null && !Object.hasOwn(routes, referenced))
        return `route "${id}" target "${target.model ?? target}" references route "${referenced}", which is not one of the saved routes`;
    }
  }
  // A route expands to models only through a concrete target, its own or one
  // a referenced route reaches without revisiting a route (OpenCode's trail
  // guard drops the revisits, and a simple path to a concrete target never
  // revisits one). Seed the routes that name a concrete target, then grow
  // through references until no route is added; what is left reaches none.
  const expanding = new Set(
    Object.entries(routes)
      .filter(([, route]) => route.targets.some((target) => routeReferenceOf(target) === null))
      .map(([id]) => id),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const [id, route] of Object.entries(routes)) {
      if (expanding.has(id)) continue;
      if (route.targets.some((target) => expanding.has(routeReferenceOf(target)))) {
        expanding.add(id);
        grew = true;
      }
    }
  }
  for (const id of Object.keys(routes))
    if (!expanding.has(id))
      return `route "${id}" would expand to no models: its targets only reference routes in a cycle that reaches no concrete model target`;
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
