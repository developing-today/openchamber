import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  emptyPoolPlanLinks,
  readPoolPlanLinks,
  registerPoolPlanLinkRoutes,
  setPoolPlanLink,
  writePoolPlanLinks,
} from './pool-plan-links.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pool-plan-links-'));

describe('pool-plan-links store', () => {
  it('reads an empty store when no file exists yet', () => {
    expect(readPoolPlanLinks(dir())).toEqual(emptyPoolPlanLinks());
  });

  it('links a target to a plan, and a second target to the same plan as a sibling', () => {
    const data = dir();
    const first = setPoolPlanLink(readPoolPlanLinks(data), 'openai/gpt-6-luna', 'openai-plus', data);
    const second = setPoolPlanLink(first, 'openai/gpt-6-luna-b', 'openai-plus', data);
    expect(second.links).toEqual({ 'openai/gpt-6-luna': 'openai-plus', 'openai/gpt-6-luna-b': 'openai-plus' });
    expect(readPoolPlanLinks(data)).toEqual(second);
  });

  it('clears a link when planID is null', () => {
    const data = dir();
    const linked = setPoolPlanLink(readPoolPlanLinks(data), 'openai/gpt-6-luna', 'openai-plus', data);
    const cleared = setPoolPlanLink(linked, 'openai/gpt-6-luna', null, data);
    expect(cleared.links).toEqual({});
  });

  it('refuses a malformed value instead of writing it', () => {
    const data = dir();
    expect(() => writePoolPlanLinks({ version: 1, links: { a: 1 } }, data)).toThrow('links must map');
  });

  it('throws on a damaged file instead of reading it as empty', () => {
    const data = dir();
    fs.writeFileSync(path.join(data, 'pool-plan-links.json'), '{ not json');
    expect(() => readPoolPlanLinks(data)).toThrow(/does not match|not valid JSON/);
  });
});

describe('PUT /api/model-routes/plan-links', () => {
  const appFor = (data) => {
    const app = express();
    registerPoolPlanLinkRoutes(app, { openchamberDataDir: data, loadPlanStore: () => ({ plans: [{ id: 'openai-plus' }] }) });
    return app;
  };

  it('links a target, then clears it with a null planID', async () => {
    const data = dir();
    const app = appFor(data);
    const linked = await request(app).put('/api/model-routes/plan-links').send({ target: 'openai/gpt-6-luna', planID: 'openai-plus' });
    expect(linked.status).toBe(200);
    expect(linked.body.links).toEqual({ 'openai/gpt-6-luna': 'openai-plus' });
    const cleared = await request(app).put('/api/model-routes/plan-links').send({ target: 'openai/gpt-6-luna', planID: null });
    expect(cleared.body.links).toEqual({});
    expect(readPoolPlanLinks(data).links).toEqual({});
  });

  it('refuses a plan that does not exist, and still clears a link to one', async () => {
    const data = dir();
    writePoolPlanLinks({ version: 1, links: { 'openai/gpt-6-luna': 'deleted-plan' } }, data);
    const app = appFor(data);
    const refused = await request(app).put('/api/model-routes/plan-links').send({ target: 'openai/gpt-6-luna', planID: 'no-such-plan' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('UNKNOWN_PLAN');
    expect(readPoolPlanLinks(data).links).toEqual({ 'openai/gpt-6-luna': 'deleted-plan' });
    const cleared = await request(app).put('/api/model-routes/plan-links').send({ target: 'openai/gpt-6-luna', planID: null });
    expect(cleared.body.links).toEqual({});
  });

  it('refuses a request without a target', async () => {
    const response = await request(appFor(dir())).put('/api/model-routes/plan-links').send({ planID: 'openai-plus' });
    expect(response.status).toBe(400);
  });

  it('has no GET route', async () => {
    const response = await request(appFor(dir())).get('/api/model-routes/plan-links');
    expect(response.status).toBe(404);
  });
});
