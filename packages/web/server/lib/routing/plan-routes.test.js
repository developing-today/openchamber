import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { registerPlanRoutes } from './plan-routes.js';

const NOW = '2026-10-14T09:00:00.000Z';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plan-routes-'));

const createApp = (dataDir) => {
  const app = express();
  registerPlanRoutes(app, { dataDir, now: () => new Date(NOW) });
  return app;
};

describe('plan routes', () => {
  it('records a plan and returns it with the whole store', async () => {
    const dataDir = dir();
    const app = createApp(dataDir);
    const saved = await request(app)
      .put('/api/routing/plans/record')
      .send({ providerID: 'anthropic', plan: 'Max 20x', quotas: [{ name: '5-hour', unit: 'messages', windowHours: 5 }] })
      .expect(200);
    expect(saved.body).toMatchObject({ id: 'anthropic-max-20x', providerID: 'anthropic', updatedAt: NOW });
    const listed = await request(app).get('/api/routing/plans').expect(200);
    expect(listed.body.plans.map((plan) => plan.id)).toEqual(['anthropic-max-20x']);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'plans.json'), 'utf8')).plans).toHaveLength(1);
  });

  it('answers a bad field with a 400 that names the problem', async () => {
    const app = createApp(dir());
    const rejected = await request(app)
      .put('/api/routing/plans/record')
      .send({ providerID: 'openai', coverage: 'lottery' })
      .expect(400);
    expect(rejected.body.error).toBeTruthy();
  });

  it('sets a model tier and a pool purpose', async () => {
    const app = createApp(dir());
    const model = await request(app)
      .put('/api/routing/plans/model')
      .send({ model: 'openai/gpt-6-astra', tier: 'high', coveredBy: ['openai-plus'] })
      .expect(200);
    expect(model.body).toMatchObject({ tier: 'high', coveredBy: ['openai-plus'] });
    await request(app).put('/api/routing/plans/model').send({ model: 'no-slash', tier: 'high' }).expect(400);
    const pool = await request(app)
      .put('/api/routing/plans/pool')
      .send({ id: 'hard', tier: 'high', purpose: 'debugging with an unknown cause' })
      .expect(200);
    expect(pool.body).toMatchObject({ tier: 'high', purpose: 'debugging with an unknown cause' });
  });

  it('adds a note from the UI and lists it back', async () => {
    const app = createApp(dir());
    const added = await request(app)
      .post('/api/routing/plans/notes')
      .send({ text: 'ran out of claude too fast', kind: 'experience', providerID: 'anthropic', source: 'model' })
      .expect(200);
    expect(added.body).toMatchObject({ kind: 'experience', source: 'ui', providerID: 'anthropic' });
    const listed = await request(app).get('/api/routing/plans/notes?limit=5').expect(200);
    expect(listed.body.notes.map((note) => note.text)).toEqual(['ran out of claude too fast']);
  });

  it('refuses to write over a malformed plan file, and leaves it as it was', async () => {
    const dataDir = dir();
    fs.writeFileSync(path.join(dataDir, 'plans.json'), '{ broken');
    const app = createApp(dataDir);
    await request(app).put('/api/routing/plans/record').send({ providerID: 'openai' }).expect(409);
    expect(fs.readFileSync(path.join(dataDir, 'plans.json'), 'utf8')).toBe('{ broken');
  });
});
