/**
 * Staggered rotation: moves sessions off a pool target one at a time before
 * the target's plan runs dry, so they do not all lose their prompt cache in
 * the same moment when it does.
 *
 * OpenCode keeps each session's pool target in memory and has no route to
 * move one session; route overrides apply to every session at once. The one
 * per-session control OpenChamber has is the session's model, so a move sets
 * the session's model to a sibling target. The session leaves the pool and no
 * longer fails over inside it. Off by default for that reason.
 *
 * Each tick (once a minute while on), per pool:
 * - a source is a target whose linked plan projects to `warn` or `over`;
 * - a destination is another concrete target of the pool that is not linked
 *   to the source's plan, is not itself near its limit, and whose latest
 *   request did not fail; one with a recent success wins over one with no
 *   recent traffic, then the most plan headroom;
 * - only sessions still on the pool count, and the target must have two or
 *   more of them: the last one stays;
 * - one session moves: running subagents (a `parentID` and a request in the
 *   last two minutes) first, then the session whose last request is oldest,
 *   whose cache is the coldest; finished subagents are not moved;
 * - sessions on Auto, and sessions whose model is no longer the pool, stay;
 * - a session whose switch fails is skipped for 30 minutes and the next one
 *   is tried.
 * A pool moves at most one session per `intervalMinutes`. The pace, the
 * failed sessions and the recent moves are kept in memory; a restart forgets
 * them.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { z } from 'zod';

import { querySessionsOnTarget, queryTargetReliability, resolveOpenCodeDbPath } from './model-route-stats.js';
import { readModelRoutes } from './model-routes.js';
import { computePoolHealth } from './pool-health.js';

const FILE_NAME = 'pool-rotation.json';
const TICK_MS = 60_000;
const MOVE_LOG_LIMIT = 20;
const ROUTE_PROVIDER_ID = 'opencode-route';

export const DEFAULT_ROTATION_SETTINGS = Object.freeze({ enabled: false, intervalMinutes: 5 });

const settingsSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(60),
});

const settingsPatchSchema = settingsSchema.partial().strict();

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/** The rotation settings. A missing file is the defaults; a malformed one throws, so a save never replaces it blind. */
export const readRotationSettings = (dataDir) => {
  const file = path.join(dataDir, FILE_NAME);
  if (!fs.existsSync(file)) return { ...DEFAULT_ROTATION_SETTINGS };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw httpError(409, `${file} is not valid JSON. Fix or move it before changing rotation settings.`, 'ROTATION_SETTINGS_MALFORMED');
  }
  const result = settingsSchema.safeParse({ ...DEFAULT_ROTATION_SETTINGS, ...parsed });
  if (!result.success) throw httpError(409, `${file} does not match the rotation settings format.`, 'ROTATION_SETTINGS_MALFORMED');
  return result.data;
};

const writeRotationSettings = (dataDir, settings) => {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, FILE_NAME);
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(temporary, file);
  return settings;
};

// A pool target is `provider/model[#variant]` or `{ model, defaultVariant }`.
const rawTargetSchema = z.union([
  z.string().transform((model) => ({ model, defaultVariant: undefined })),
  z.object({ model: z.string(), defaultVariant: z.string().optional() }),
]);

/** `provider/model[#variant]` as a session model, or null for a pattern, a nested pool or a malformed entry. */
const concreteModel = (rawTarget) => {
  const parsed = rawTargetSchema.safeParse(rawTarget);
  if (!parsed.success) return null;
  const [reference, inlineVariant] = parsed.data.model.split('#');
  const slash = reference.indexOf('/');
  if (slash <= 0) return null;
  const providerID = reference.slice(0, slash);
  const id = reference.slice(slash + 1);
  if (providerID === ROUTE_PROVIDER_ID || id === '' || id.includes('*')) return null;
  const model = { providerID, id };
  const variant = inlineVariant ?? parsed.data.defaultVariant;
  if (variant) model.variant = variant;
  return { ref: reference, model };
};

const NEAR_LIMIT = new Set(['warn', 'over']);

// A subagent whose last request is older than this has finished; it will not
// send again, so moving it would spend a move on nothing.
const RUNNING_WITHIN_MS = 2 * 60_000;
// A session whose switch failed (deleted directory, OpenCode refusing) is left
// alone this long, so it does not block its pool every minute.
const FAILED_SESSION_BACKOFF_MS = 30 * 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;

/** Whether the target's latest recorded request in the window failed: it is failing right now. */
const failingNow = (reliability) => reliability !== undefined && reliability.failures > 0
  && (reliability.lastSuccess === null || reliability.lastFailure > reliability.lastSuccess);

/**
 * The best destination for sessions leaving `source`, or null when no target
 * has headroom. A moved session has no failover, so a target whose latest
 * request failed is never chosen, and one with a recent success ranks before
 * one with no recent traffic; then the most plan headroom wins.
 */
export const pickDestination = (poolHealth, rawTargets, source, reliabilityByRef = new Map()) => {
  const sourcePlanID = source.plan?.id ?? null;
  const candidates = rawTargets
    .map(concreteModel)
    .filter((candidate) => candidate !== null && candidate.ref !== source.ref)
    .map((candidate) => ({
      ...candidate,
      health: poolHealth.targets.find((target) => target.ref === candidate.ref),
      reliability: reliabilityByRef.get(candidate.ref),
    }))
    .filter(({ health, reliability }) => {
      if (!health || failingNow(reliability)) return false;
      if (sourcePlanID !== null && health.plan?.id === sourcePlanID) return false;
      return !NEAR_LIMIT.has(health.plan?.projection?.status ?? 'ok');
    });
  const proven = ({ reliability }) => (reliability?.lastSuccess ? 0 : 1);
  const headroom = ({ health }) => (health.plan?.projection ? health.plan.projection.ratio : Number.POSITIVE_INFINITY);
  return candidates.toSorted((left, right) => proven(left) - proven(right) || headroom(left) - headroom(right))[0] ?? null;
};

/** Subagents first, then the session idle longest. */
export const orderForMove = (sessions) =>
  sessions.toSorted((left, right) => {
    if (left.subagent !== right.subagent) return left.subagent ? -1 : 1;
    return left.lastAttempt - right.lastAttempt;
  });

const withTimeout = (promise, ms, what) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * The rotation job. Every dependency is injected:
 * - `computeHealth()` resolves to the pool health report;
 * - `readRoutes()` returns the configured `model_routes` map;
 * - `sessionsOnTarget({ routeID, providerID, modelID })` resolves to `[{ sessionID, lastAttempt }]`;
 * - `targetReliability()` resolves to `[{ providerID, modelID, failures, lastSuccess, lastFailure }]`;
 * - `getSession(sessionID)` resolves to `{ parentID?, model? }` (OpenCode's `Session.Info`);
 * - `switchModel(sessionID, model)` sets the session's model;
 * - `isAutoSession(sessionID)` says whether Auto picks its model per send.
 * OpenCode calls are bounded by `callTimeoutMs`, so a call that never answers
 * cannot stop the job.
 */
export const createPoolRotation = ({
  dataDir,
  computeHealth,
  readRoutes,
  sessionsOnTarget,
  targetReliability = async () => [],
  getSession,
  switchModel,
  isAutoSession = () => false,
  now = () => Date.now(),
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  log = console,
}) => {
  const lastMoveByPool = new Map();
  const failedUntil = new Map();
  const moves = [];
  let running = false;

  const settings = () => readRotationSettings(dataDir);

  const updateSettings = (patch) => {
    const parsed = settingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw httpError(400, 'enabled must be true or false and intervalMinutes a whole number from 1 to 60', 'INVALID_ROTATION_SETTINGS');
    return writeRotationSettings(dataDir, { ...settings(), ...parsed.data });
  };

  /**
   * The live sessions on `source` in `poolID`: those still on the pool, not on
   * Auto, and not finished subagents. `movable` leaves out the ones in back-off
   * after a failed switch and is in the order they would move.
   */
  const sessionsOn = async (poolID, source, tickStart) => {
    const [providerID, ...rest] = source.ref.split('/');
    const onTarget = await sessionsOnTarget({ routeID: poolID, providerID, modelID: rest.join('/') });
    const live = [];
    for (const { sessionID, lastAttempt } of onTarget) {
      if (isAutoSession(sessionID)) continue;
      const session = await withTimeout(getSession(sessionID), callTimeoutMs, 'Reading the session').catch(() => null);
      // Only a session still on this pool moves; the user's own choice since then stands.
      if (session?.model?.providerID !== ROUTE_PROVIDER_ID || session.model.id !== poolID) continue;
      const subagent = Boolean(session.parentID);
      if (subagent && tickStart - lastAttempt > RUNNING_WITHIN_MS) continue;
      live.push({ sessionID, lastAttempt, subagent });
    }
    const movable = orderForMove(live.filter(({ sessionID }) => (failedUntil.get(sessionID) ?? 0) <= tickStart));
    return { live, movable };
  };

  /** Picks and moves at most one session in `poolID`; resolves to the move or null. */
  const rotatePool = async (poolID, poolHealth, rawTargets, reliabilityByRef, tickStart) => {
    const sources = poolHealth.targets
      .filter((target) => NEAR_LIMIT.has(target.plan?.projection?.status))
      .toSorted((left, right) => right.plan.projection.ratio - left.plan.projection.ratio);
    for (const source of sources) {
      const destination = pickDestination(poolHealth, rawTargets, source, reliabilityByRef);
      if (!destination) continue;
      const { live, movable } = await sessionsOn(poolID, source, tickStart);
      // The last session on a target stays: moving it saves no cache from a shared bust.
      if (live.length < 2) continue;
      for (const chosen of movable) {
        try {
          await withTimeout(switchModel(chosen.sessionID, destination.model), callTimeoutMs, 'Switching the session model');
        } catch (error) {
          failedUntil.set(chosen.sessionID, tickStart + FAILED_SESSION_BACKOFF_MS);
          log.warn?.(`[pool-rotation] ${poolID}: could not move ${chosen.sessionID}: ${error?.message ?? error}`);
          continue;
        }
        const move = { at: tickStart, poolID, sessionID: chosen.sessionID, subagent: chosen.subagent, from: source.ref, to: destination.ref };
        moves.unshift(move);
        moves.length = Math.min(moves.length, MOVE_LOG_LIMIT);
        return move;
      }
    }
    return null;
  };

  /** One pass over every pool. Never throws: a failed pool is logged and the rest still run. */
  const tick = async () => {
    if (running) return [];
    running = true;
    // Moves and the pace are stamped with the tick's start, so a 5-minute pace
    // moves on the fifth tick, not the sixth.
    const tickStart = now();
    try {
      const current = settings();
      if (!current.enabled) return [];
      const health = await computeHealth();
      if (!health.statsAvailable) return [];
      const routes = readRoutes();
      const reliabilityByRef = new Map((await targetReliability()).map((row) => [`${row.providerID}/${row.modelID}`, row]));
      const made = [];
      for (const [poolID, poolHealth] of Object.entries(health.pools)) {
        const last = lastMoveByPool.get(poolID);
        if (last !== undefined && tickStart - last < current.intervalMinutes * 60_000) continue;
        try {
          const move = await rotatePool(poolID, poolHealth, routes[poolID]?.targets ?? [], reliabilityByRef, tickStart);
          if (move) {
            lastMoveByPool.set(poolID, move.at);
            made.push(move);
          }
        } catch (error) {
          log.warn?.(`[pool-rotation] ${poolID}: ${error?.message ?? error}`);
        }
      }
      return made;
    } catch (error) {
      log.warn?.(`[pool-rotation] tick failed: ${error?.message ?? error}`);
      return [];
    } finally {
      running = false;
    }
  };

  let timer = null;
  const start = () => {
    if (timer) return;
    timer = setInterval(() => void tick(), TICK_MS);
    timer.unref?.();
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { settings, updateSettings, tick, start, stop, recentMoves: () => [...moves] };
};

/**
 * The two OpenCode session calls rotation needs. Session routes resolve the
 * session's own location, so no directory header is sent. `session.get` reads
 * the record only; `session.switchModel` goes through OpenCode's session
 * location middleware, which starts the session's location (its plugins and
 * MCP servers) when it is not running.
 */
const createOpenCodeSessionAccess = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const client = () => OpenCode.make({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: { ...getOpenCodeAuthHeaders() },
  });
  return {
    getSession: (sessionID) => client().session.get({ sessionID }, { signal: AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) }),
    switchModel: (sessionID, model) => client().session.switchModel({ sessionID, model }, { signal: AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) }),
  };
};

export const registerPoolRotationRoutes = (app, rotation) => {
  app.get('/api/model-routes/rotation', (_req, res) => {
    try {
      res.json({ settings: rotation.settings(), moves: rotation.recentMoves() });
    } catch (error) {
      res.status(error?.status ?? 500).json({ error: error?.message ?? 'Failed to read rotation settings', code: error?.code });
    }
  });

  app.put('/api/model-routes/rotation', express.json({ limit: '4kb' }), (req, res) => {
    try {
      res.json({ settings: rotation.updateSettings(req.body), moves: rotation.recentMoves() });
    } catch (error) {
      res.status(error?.status ?? 500).json({ error: error?.message ?? 'Failed to save rotation settings', code: error?.code });
    }
  });
};

/** Builds the rotation job from the server's dependencies, registers its routes and starts its timer. */
export const registerPoolRotation = (app, { readConfigLayers, openchamberDataDir, buildOpenCodeUrl, getOpenCodeAuthHeaders, isAutoSession, isOpenCodeLocal = () => true }) => {
  const sessions = createOpenCodeSessionAccess({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
  const rotation = createPoolRotation({
    dataDir: openchamberDataDir,
    // A remote OpenCode's telemetry is not on this machine; health then reports it unavailable and nothing moves.
    computeHealth: () => computePoolHealth({ readConfigLayers, openchamberDataDir, telemetryLocal: isOpenCodeLocal() }),
    readRoutes: () => readModelRoutes(readConfigLayers(null).mergedConfig),
    sessionsOnTarget: (target) => querySessionsOnTarget(resolveOpenCodeDbPath(), target),
    targetReliability: () => queryTargetReliability(resolveOpenCodeDbPath()),
    getSession: sessions.getSession,
    switchModel: sessions.switchModel,
    isAutoSession,
  });
  registerPoolRotationRoutes(app, rotation);
  rotation.start();
  return rotation;
};
