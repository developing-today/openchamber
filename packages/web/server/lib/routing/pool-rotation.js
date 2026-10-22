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
 * - a source is a target whose linked plan projects to `warn` or `over` with
 *   two or more sessions on it;
 * - a destination is another concrete target of the pool that is not linked
 *   to the source's plan and is not itself near its limit; a linked target
 *   with headroom wins over an unlinked one, the lowest projection first;
 * - one session moves: subagents (sessions with a `parentID`) first, then the
 *   session whose last request is oldest, whose cache is the coldest;
 * - sessions on Auto, and sessions whose model is no longer the pool, stay.
 * A pool moves at most one session per `intervalMinutes`. The pace and the
 * recent moves are kept in memory; a restart starts both again.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { OpenCode } from '@opencode/client';
import { z } from 'zod';

import { querySessionsOnTarget, resolveOpenCodeDbPath } from './model-route-stats.js';
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
  const variant = inlineVariant ?? parsed.data.defaultVariant;
  return { ref: reference, model: { providerID, id, ...(variant ? { variant } : {}) } };
};

const NEAR_LIMIT = new Set(['warn', 'over']);

/** The best destination for sessions leaving `source`, or null when no target has headroom. */
export const pickDestination = (poolHealth, rawTargets, source) => {
  const sourcePlanID = source.plan?.id ?? null;
  const candidates = rawTargets
    .map(concreteModel)
    .filter((candidate) => candidate !== null && candidate.ref !== source.ref)
    .map((candidate) => ({ ...candidate, health: poolHealth.targets.find((target) => target.ref === candidate.ref) }))
    .filter(({ health }) => {
      if (!health) return false;
      if (sourcePlanID !== null && health.plan?.id === sourcePlanID) return false;
      return !NEAR_LIMIT.has(health.plan?.projection?.status ?? 'ok');
    });
  const score = ({ health }) => (health.plan?.projection ? health.plan.projection.ratio : Number.POSITIVE_INFINITY);
  return candidates.toSorted((left, right) => score(left) - score(right))[0] ?? null;
};

/** Subagents first, then the session idle longest. */
export const orderForMove = (sessions) =>
  sessions.toSorted((left, right) => {
    if (left.subagent !== right.subagent) return left.subagent ? -1 : 1;
    return left.lastAttempt - right.lastAttempt;
  });

/**
 * The rotation job. Every dependency is injected:
 * - `computeHealth()` resolves to the pool health report;
 * - `readRoutes()` returns the configured `model_routes` map;
 * - `sessionsOnTarget({ routeID, providerID, modelID })` resolves to `[{ sessionID, lastAttempt }]`;
 * - `getSession(sessionID)` resolves to `{ parentID?, model? }` (OpenCode's `Session.Info`);
 * - `switchModel(sessionID, model)` sets the session's model;
 * - `isAutoSession(sessionID)` says whether Auto picks its model per send.
 */
export const createPoolRotation = ({
  dataDir,
  computeHealth,
  readRoutes,
  sessionsOnTarget,
  getSession,
  switchModel,
  isAutoSession = () => false,
  now = () => Date.now(),
  log = console,
}) => {
  const lastMoveByPool = new Map();
  const moves = [];
  let running = false;

  const settings = () => readRotationSettings(dataDir);

  const updateSettings = (patch) => {
    const parsed = settingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw httpError(400, 'enabled must be true or false and intervalMinutes a whole number from 1 to 60', 'INVALID_ROTATION_SETTINGS');
    return writeRotationSettings(dataDir, { ...settings(), ...parsed.data });
  };

  /** Picks and moves at most one session in `poolID`; resolves to the move or null. */
  const rotatePool = async (poolID, poolHealth, rawTargets) => {
    const sources = poolHealth.targets
      .filter((target) => target.activeSessions !== null && target.activeSessions >= 2 && NEAR_LIMIT.has(target.plan?.projection?.status))
      .toSorted((left, right) => right.plan.projection.ratio - left.plan.projection.ratio);
    for (const source of sources) {
      const destination = pickDestination(poolHealth, rawTargets, source);
      if (!destination) continue;
      const [providerID, ...rest] = source.ref.split('/');
      const onTarget = await sessionsOnTarget({ routeID: poolID, providerID, modelID: rest.join('/') });
      const eligible = [];
      for (const { sessionID, lastAttempt } of onTarget) {
        if (isAutoSession(sessionID)) continue;
        const session = await getSession(sessionID).catch(() => null);
        // Only a session still on this pool moves; the user's own choice since then stands.
        if (session?.model?.providerID !== ROUTE_PROVIDER_ID || session.model.id !== poolID) continue;
        eligible.push({ sessionID, lastAttempt, subagent: Boolean(session.parentID) });
      }
      const [chosen] = orderForMove(eligible);
      if (!chosen) continue;
      await switchModel(chosen.sessionID, destination.model);
      const move = {
        at: now(),
        poolID,
        sessionID: chosen.sessionID,
        subagent: chosen.subagent,
        from: source.ref,
        to: destination.ref,
      };
      moves.unshift(move);
      moves.length = Math.min(moves.length, MOVE_LOG_LIMIT);
      return move;
    }
    return null;
  };

  /** One pass over every pool. Never throws: a failed pool is logged and the rest still run. */
  const tick = async () => {
    if (running) return [];
    running = true;
    try {
      const current = settings();
      if (!current.enabled) return [];
      const health = await computeHealth();
      if (!health.statsAvailable) return [];
      const routes = readRoutes();
      const made = [];
      for (const [poolID, poolHealth] of Object.entries(health.pools)) {
        const last = lastMoveByPool.get(poolID);
        if (last !== undefined && now() - last < current.intervalMinutes * 60_000) continue;
        try {
          const move = await rotatePool(poolID, poolHealth, routes[poolID]?.targets ?? []);
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
 * session's own location, so no directory header is sent and no location
 * starts for them.
 */
export const createOpenCodeSessionAccess = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const client = () => OpenCode.make({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: { ...getOpenCodeAuthHeaders() },
  });
  return {
    getSession: (sessionID) => client().session.get({ sessionID }),
    switchModel: (sessionID, model) => client().session.switchModel({ sessionID, model }),
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
export const registerPoolRotation = (app, { readConfigLayers, openchamberDataDir, buildOpenCodeUrl, getOpenCodeAuthHeaders, isAutoSession }) => {
  const sessions = createOpenCodeSessionAccess({ buildOpenCodeUrl, getOpenCodeAuthHeaders });
  const rotation = createPoolRotation({
    dataDir: openchamberDataDir,
    computeHealth: () => computePoolHealth({ readConfigLayers, openchamberDataDir }),
    readRoutes: () => readModelRoutes(readConfigLayers(null).mergedConfig),
    sessionsOnTarget: (target) => querySessionsOnTarget(resolveOpenCodeDbPath(), target),
    getSession: sessions.getSession,
    switchModel: sessions.switchModel,
    isAutoSession,
  });
  registerPoolRotationRoutes(app, rotation);
  rotation.start();
  return rotation;
};
