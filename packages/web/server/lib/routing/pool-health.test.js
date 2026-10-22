import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { computePoolHealth } from './pool-health.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pool-health-'));

const seedDb = (dir, rows) => {
  const dbPath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`create table route_attempt (
    id integer primary key autoincrement, time_started integer not null, time_ended integer not null,
    session_id text, assistant_message_id text, route_id text not null,
    provider_id text not null, model_id text not null, variant text,
    outcome text not null, error_tag text, error_code text, error_status integer,
    error_message text, error_body text, retryable integer, output_started integer not null,
    failed_over_to text, hedged integer, first_token_ms real, response_ms real,
    tokens_per_second real, tokens_input integer, tokens_estimated integer,
    tokens_output integer, tokens_reasoning integer, tokens_cache_read integer,
    tokens_cache_write integer, quota text
  )`);
  const insert = db.prepare(`insert into route_attempt
    (time_started, time_ended, session_id, route_id, provider_id, model_id, outcome, output_started, tokens_input, tokens_output, tokens_reasoning)
    values (?, ?, ?, 'pool', ?, ?, 'success', 1, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(row.time, row.time + 100, row.session, row.provider, row.model, row.tokensIn ?? null, row.tokensOut ?? null, row.tokensReasoning ?? null);
  }
  db.close();
  return dbPath;
};

const plan = (id, quotas) => ({
  id, providerID: 'openai', label: id, coverage: 'subscription', status: 'active', quotas,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

const baseDeps = (dbPath, { routes, plans = [], links = {} }) => ({
  readConfigLayers: () => ({ mergedConfig: { experimental: { model_routes: routes } } }),
  resolveDbPath: () => dbPath,
  loadPlanStore: () => ({ version: 1, plans, models: {}, pools: {} }),
  loadPoolPlanLinks: () => ({ version: 1, links }),
  openchamberDataDir: '/unused',
});

describe('computePoolHealth', () => {
  it('counts active sessions per target and leaves unlinked targets with no plan info', async () => {
    const dir = tempDir();
    const now = Date.now();
    const dbPath = seedDb(dir, [
      { time: now - 1000, session: 's1', provider: 'openai', model: 'a' },
      { time: now - 2000, session: 's2', provider: 'openai', model: 'a' },
      { time: now - 3000, session: 's1', provider: 'openai', model: 'a' }, // same session again, counts once
      { time: now - 4000, session: 's3', provider: 'anthropic', model: 'b' },
    ]);
    const routes = { pool1: { targets: ['openai/a', 'anthropic/b'] } };
    const health = await computePoolHealth({ ...baseDeps(dbPath, { routes }), now });
    expect(health.available).toBe(true);
    expect(health.statsAvailable).toBe(true);
    const [openaiTarget, anthropicTarget] = health.pools.pool1.targets;
    expect(openaiTarget).toMatchObject({ ref: 'openai/a', activeSessions: 2, plan: null, blastRadius: true, suggestion: null });
    expect(anthropicTarget).toMatchObject({ ref: 'anthropic/b', activeSessions: 1, plan: null, blastRadius: false });
  });

  it('combines sibling targets on the same plan and flags a weighted pool nearing its quota', async () => {
    const dir = tempDir();
    const now = Date.now();
    // 48 attempts across both targets in the last 24h -> 2/hour -> over a 24h window that would be 48, past the 10-request limit.
    const rows = [];
    for (let i = 0; i < 24; i += 1) rows.push({ time: now - i * 3_600_000, session: `s${i}`, provider: 'openai', model: 'a' });
    for (let i = 0; i < 24; i += 1) rows.push({ time: now - i * 3_600_000, session: `t${i}`, provider: 'openai', model: 'a-secondary' });
    const dbPath = seedDb(dir, rows);
    const routes = {
      pool1: {
        selection: 'weighted',
        targets: ['openai/a', 'openai/a-secondary'],
        weights: { 'openai/a': 1, 'openai/a-secondary': 1 },
      },
    };
    const plans = [{
      id: 'openai-plus', providerID: 'openai', label: 'OpenAI Plus', coverage: 'subscription', status: 'active',
      quotas: [{ name: 'daily', unit: 'requests', limit: 10, windowHours: 24 }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }];
    const links = { 'openai/a': 'openai-plus', 'openai/a-secondary': 'openai-plus' };
    const health = await computePoolHealth({ ...baseDeps(dbPath, { routes, plans, links }), now, hours: 24 });
    const [first, second] = health.pools.pool1.targets;
    expect(first.plan.id).toBe('openai-plus');
    expect(first.plan.siblingRefs).toEqual(['openai/a-secondary']);
    expect(first.plan.projection.status).toBe('over');
    expect(first.suggestion).toBe('lower-weight');
    expect(second.plan.siblingRefs).toEqual(['openai/a']);
  });

  it('projects a token window from input, output and reasoning tokens', async () => {
    const now = Date.now();
    // 12 attempts over 24h at 100 + 50 + 50 tokens each: 2,400 tokens a day against a 2,000-token daily window.
    const rows = [];
    for (let i = 0; i < 12; i += 1) {
      rows.push({ time: now - i * 3_600_000, session: `s${i}`, provider: 'openai', model: 'a', tokensIn: 100, tokensOut: 50, tokensReasoning: 50 });
    }
    const dbPath = seedDb(tempDir(), rows);
    const plans = [plan('openai-tokens', [{ name: 'daily tokens', unit: 'tokens', limit: 2000, windowHours: 24 }])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, plans, links: { 'openai/a': 'openai-tokens' } }),
      now,
      hours: 24,
    });
    expect(health.pools.pool1.targets[0].plan.projection).toMatchObject({ unit: 'tokens', projected: 2400, status: 'over' });
  });

  it('reports the tightest of several quota windows', async () => {
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 6; i += 1) rows.push({ time: now - i * 3_600_000, session: `s${i}`, provider: 'openai', model: 'a' });
    const dbPath = seedDb(tempDir(), rows);
    // 6 requests a day: 6 percent of the loose window, 75 percent of the tight one.
    const plans = [plan('openai-two-windows', [
      { name: 'loose', unit: 'requests', limit: 100, windowHours: 24 },
      { name: 'tight', unit: 'requests', limit: 8, windowHours: 24 },
    ])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, plans, links: { 'openai/a': 'openai-two-windows' } }),
      now,
      hours: 24,
    });
    expect(health.pools.pool1.targets[0].plan.projection).toMatchObject({ quotaName: 'tight', status: 'warn' });
  });

  it('falls back to a 24-hour window when hours is not a positive number', async () => {
    const now = Date.now();
    const dbPath = seedDb(tempDir(), [{ time: now - 1000, session: 's1', provider: 'openai', model: 'a' }]);
    const plans = [plan('openai-plus', [{ name: 'daily', unit: 'requests', limit: 10, windowHours: 24 }])];
    const health = await computePoolHealth({
      ...baseDeps(dbPath, { routes: { pool1: { targets: ['openai/a'] } }, plans, links: { 'openai/a': 'openai-plus' } }),
      now,
      hours: Number.NaN,
    });
    expect(health.pools.pool1.targets[0].plan.projection).toMatchObject({ projected: 1, status: 'ok' });
  });

  it('degrades to statsAvailable: false instead of throwing when the database is missing', async () => {
    const routes = { pool1: { targets: ['openai/a'] } };
    const health = await computePoolHealth({ ...baseDeps(path.join(tempDir(), 'missing.db'), { routes }) });
    expect(health.available).toBe(true);
    expect(health.statsAvailable).toBe(false);
    expect(health.statsReason).toBe('no-database');
    expect(health.pools.pool1.targets[0]).toMatchObject({ activeSessions: null, plan: null, blastRadius: false });
  });
});
