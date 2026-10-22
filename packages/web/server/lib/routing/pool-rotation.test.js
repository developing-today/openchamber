import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { querySessionsOnTarget } from './model-route-stats.js';
import {
  DEFAULT_ROTATION_SETTINGS,
  createPoolRotation,
  orderForMove,
  pickDestination,
  readRotationSettings,
  registerPoolRotationRoutes,
} from './pool-rotation.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pool-rotation-'));
const MINUTE = 60_000;

const projection = (ratio) => ({
  quotaName: 'daily', unit: 'requests', limit: 100, windowHours: 24, projected: ratio * 100, ratio,
  status: ratio >= 1 ? 'over' : ratio >= 0.7 ? 'warn' : 'ok',
});
const target = (ref, activeSessions, planID = null, ratio = null) => ({
  ref,
  activeSessions,
  blastRadius: activeSessions >= 2,
  suggestion: null,
  plan: planID ? { id: planID, label: planID, providerID: ref.split('/')[0], siblingRefs: [], projection: ratio === null ? null : projection(ratio) } : null,
});

/** One pool `busy` whose first target is near its plan's limit, with three sessions on it. */
const setup = ({
  enabled = true,
  intervalMinutes = 5,
  targets = [target('openai/a', 3, 'plan-a', 0.9), target('anthropic/b', 0, 'plan-b', 0.2)],
  rawTargets = ['openai/a', 'anthropic/b#high'],
  onTarget = [
    { sessionID: 'primary-old', lastAttempt: 1_000 },
    { sessionID: 'primary-new', lastAttempt: 5_000 },
    { sessionID: 'sub', lastAttempt: 9_000 },
  ],
  sessions = {
    'primary-old': { model: { providerID: 'opencode-route', id: 'busy' } },
    'primary-new': { model: { providerID: 'opencode-route', id: 'busy' } },
    sub: { parentID: 'primary-old', model: { providerID: 'opencode-route', id: 'busy' } },
  },
  auto = new Set(),
  statsAvailable = true,
} = {}) => {
  const data = dir();
  fs.writeFileSync(path.join(data, 'pool-rotation.json'), JSON.stringify({ enabled, intervalMinutes }));
  const switches = [];
  const clock = { now: 10 * MINUTE };
  const rotation = createPoolRotation({
    dataDir: data,
    computeHealth: async () => ({ available: true, statsAvailable, pools: { busy: { selection: 'ordered', targets } } }),
    readRoutes: () => ({ busy: { targets: rawTargets } }),
    // Like the database, this knows only the last attempts, not a model the session was switched to since.
    sessionsOnTarget: async () => onTarget,
    getSession: async (sessionID) => sessions[sessionID],
    switchModel: async (sessionID, model) => {
      switches.push({ sessionID, model });
      sessions[sessionID] = { ...sessions[sessionID], model };
    },
    isAutoSession: (sessionID) => auto.has(sessionID),
    now: () => clock.now,
    log: { warn: () => {} },
  });
  return { rotation, switches, clock, data, sessions };
};

describe('pool rotation', () => {
  it('does nothing while turned off, which is the default', async () => {
    const data = dir();
    expect(readRotationSettings(data)).toEqual(DEFAULT_ROTATION_SETTINGS);
    const { rotation, switches } = setup({ enabled: false });
    expect(await rotation.tick()).toEqual([]);
    expect(switches).toEqual([]);
  });

  it('moves a subagent first, onto the target with headroom, keeping its variant', async () => {
    const { rotation, switches } = setup();
    const [move] = await rotation.tick();
    expect(switches).toEqual([{ sessionID: 'sub', model: { providerID: 'anthropic', id: 'b', variant: 'high' } }]);
    expect(move).toMatchObject({ poolID: 'busy', sessionID: 'sub', subagent: true, from: 'openai/a', to: 'anthropic/b' });
    expect(rotation.recentMoves()).toHaveLength(1);
  });

  it('moves one session per pool per interval, then the one idle longest', async () => {
    const { rotation, switches, clock } = setup({ intervalMinutes: 5 });
    await rotation.tick();
    clock.now += 4 * MINUTE;
    expect(await rotation.tick()).toEqual([]);
    clock.now += 1 * MINUTE;
    await rotation.tick();
    expect(switches.map(({ sessionID }) => sessionID)).toEqual(['sub', 'primary-old']);
  });

  it('leaves Auto sessions and sessions no longer on the pool alone', async () => {
    const { rotation, switches } = setup({
      auto: new Set(['sub']),
      sessions: {
        'primary-old': { model: { providerID: 'openai', id: 'a' } },
        'primary-new': { model: { providerID: 'opencode-route', id: 'busy' } },
        sub: { parentID: 'x', model: { providerID: 'opencode-route', id: 'busy' } },
      },
      onTarget: [
        { sessionID: 'primary-old', lastAttempt: 1_000 },
        { sessionID: 'primary-new', lastAttempt: 5_000 },
        { sessionID: 'sub', lastAttempt: 9_000 },
      ],
    });
    await rotation.tick();
    expect(switches.map(({ sessionID }) => sessionID)).toEqual(['primary-new']);
  });

  it('moves nothing when every other target shares the plan or is near its own limit', async () => {
    const { rotation, switches } = setup({
      targets: [target('openai/a', 3, 'plan-a', 0.9), target('openai/a2', 0, 'plan-a', 0.1), target('anthropic/b', 0, 'plan-b', 0.8)],
      rawTargets: ['openai/a', 'openai/a2', 'anthropic/b'],
    });
    expect(await rotation.tick()).toEqual([]);
    expect(switches).toEqual([]);
  });

  it('moves nothing off a target with a single session, or when telemetry is unavailable', async () => {
    const single = setup({ targets: [target('openai/a', 1, 'plan-a', 0.95), target('anthropic/b', 0, 'plan-b', 0.1)] });
    expect(await single.rotation.tick()).toEqual([]);
    const blind = setup({ statsAvailable: false });
    expect(await blind.rotation.tick()).toEqual([]);
    expect([...single.switches, ...blind.switches]).toEqual([]);
  });

  it('keeps going when a session switch fails, and does not count the failure as a move', async () => {
    const { rotation, clock } = setup();
    const failing = createPoolRotation({
      dataDir: (() => { const data = dir(); fs.writeFileSync(path.join(data, 'pool-rotation.json'), JSON.stringify({ enabled: true, intervalMinutes: 5 })); return data; })(),
      computeHealth: async () => ({ available: true, statsAvailable: true, pools: { busy: { selection: 'ordered', targets: [target('openai/a', 3, 'plan-a', 0.9), target('anthropic/b', 0, 'plan-b', 0.2)] } } }),
      readRoutes: () => ({ busy: { targets: ['openai/a', 'anthropic/b'] } }),
      sessionsOnTarget: async () => [{ sessionID: 's1', lastAttempt: 1 }],
      getSession: async () => ({ model: { providerID: 'opencode-route', id: 'busy' } }),
      switchModel: async () => { throw new Error('OpenCode is restarting'); },
      now: () => clock.now,
      log: { warn: () => {} },
    });
    expect(await failing.tick()).toEqual([]);
    expect(failing.recentMoves()).toEqual([]);
    expect(await rotation.tick()).toHaveLength(1);
  });

  it('refuses invalid settings and a damaged settings file', () => {
    const { rotation, data } = setup();
    expect(() => rotation.updateSettings({ intervalMinutes: 0 })).toThrow('whole number from 1 to 60');
    expect(() => rotation.updateSettings({ enabled: 'yes' })).toThrow();
    expect(rotation.updateSettings({ intervalMinutes: 10 })).toEqual({ enabled: true, intervalMinutes: 10 });
    fs.writeFileSync(path.join(data, 'pool-rotation.json'), '{ broken');
    expect(() => readRotationSettings(data)).toThrow(/not valid JSON/);
  });
});

describe('pickDestination and orderForMove', () => {
  it('prefers a linked target with the most headroom over an unlinked one', () => {
    const health = { targets: [target('openai/a', 3, 'plan-a', 0.9), target('x/unlinked', 0), target('y/linked', 0, 'plan-y', 0.3), target('z/linked', 0, 'plan-z', 0.1)] };
    expect(pickDestination(health, ['openai/a', 'x/unlinked', 'y/linked', 'z/linked'], health.targets[0]).ref).toBe('z/linked');
  });

  it('skips patterns and nested pools as destinations', () => {
    const health = { targets: [target('openai/a', 3, 'plan-a', 0.9), target('openai/*', 0), target('opencode-route/other', 0)] };
    expect(pickDestination(health, ['openai/a', 'openai/*', 'opencode-route/other'], health.targets[0])).toBeNull();
  });

  it('orders subagents first, then by oldest last request', () => {
    const ordered = orderForMove([
      { sessionID: 'p2', subagent: false, lastAttempt: 5 },
      { sessionID: 's1', subagent: true, lastAttempt: 9 },
      { sessionID: 'p1', subagent: false, lastAttempt: 1 },
    ]);
    expect(ordered.map(({ sessionID }) => sessionID)).toEqual(['s1', 'p1', 'p2']);
  });
});

describe('querySessionsOnTarget', () => {
  it('returns sessions whose latest attempt in the route is on the target', async () => {
    const dbPath = path.join(dir(), 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`create table route_attempt (time_started integer, session_id text, route_id text, provider_id text, model_id text)`);
    const insert = db.prepare('insert into route_attempt values (?, ?, ?, ?, ?)');
    const now = Date.now();
    insert.run(now - 3 * MINUTE, 'stays', 'busy', 'openai', 'a');
    insert.run(now - 4 * MINUTE, 'moved', 'busy', 'openai', 'a');
    insert.run(now - 1 * MINUTE, 'moved', 'busy', 'anthropic', 'b');
    insert.run(now - 2 * MINUTE, 'other-route', 'calm', 'openai', 'a');
    insert.run(now - 60 * MINUTE, 'stale', 'busy', 'openai', 'a');
    db.close();
    const rows = await querySessionsOnTarget(dbPath, { routeID: 'busy', providerID: 'openai', modelID: 'a', minutes: 15, now });
    expect(rows).toEqual([{ sessionID: 'stays', lastAttempt: now - 3 * MINUTE }]);
  });
});

describe('rotation routes', () => {
  it('reads and saves the settings', async () => {
    const { rotation } = setup({ enabled: false });
    const app = express();
    registerPoolRotationRoutes(app, rotation);
    expect((await request(app).get('/api/model-routes/rotation')).body).toEqual({ settings: { enabled: false, intervalMinutes: 5 }, moves: [] });
    const saved = await request(app).put('/api/model-routes/rotation').send({ enabled: true });
    expect(saved.body.settings).toEqual({ enabled: true, intervalMinutes: 5 });
    expect((await request(app).put('/api/model-routes/rotation').send({ intervalMinutes: 99 })).status).toBe(400);
  });
});
