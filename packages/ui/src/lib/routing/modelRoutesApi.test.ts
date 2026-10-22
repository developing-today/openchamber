import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import type { ModelRoute } from './modelRoutesApi';
import { fetchMessageModelAttribution, fetchModelRoutes, saveModelRouteSchedules, saveModelRouteTuning, saveModelRoutes } from './modelRoutesApi';

type Sent = { url: string; method: string; body: string };

const sent: Sent[] = [];
let respond: (request: Sent) => Response = () => new Response('', { status: 500 });

const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  sent.length = 0;
  spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request: Sent = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? String(init.body) : '' };
    sent.push(request);
    return respond(request);
  });
});

afterEach(() => {
  mock.restore();
  respond = () => new Response('', { status: 500 });
});

describe('fetchModelRoutes', () => {
  test('reads a build without model pools as unavailable, not as an empty map', async () => {
    respond = () => new Response('', { status: 404 });
    expect(await fetchModelRoutes()).toEqual({ routes: {}, available: false });
  });

  test('reads the merged routes and the review settings', async () => {
    respond = () => reply(JSON.stringify({ routes: { kept: { targets: ['p/a'] } }, tuning: { enabled: true }, path: '/u/opencode.json' }));
    expect(await fetchModelRoutes()).toMatchObject({ routes: { kept: { targets: ['p/a'] } }, tuning: { enabled: true }, available: true });
    expect(sent[0]).toMatchObject({ url: '/api/model-routes', method: 'GET' });
  });
});

describe('saveModelRoutes', () => {
  test('sends the whole route map in one PUT and returns the saved state', async () => {
    const routes = { kept: { targets: ['p/a', 'p/b'], selection: 'weighted', weights: { 'p/a': 2 } } } satisfies Record<string, ModelRoute>;
    respond = (request) => reply(request.body);
    const state = await saveModelRoutes(routes);
    expect(sent).toEqual([{ url: '/api/model-routes', method: 'PUT', body: JSON.stringify({ routes }) }]);
    expect(state).toMatchObject({ routes, available: true });
  });

  test('throws the server message when the save is refused', async () => {
    respond = () => reply(JSON.stringify({ error: 'route "kept" has unknown key "attmepts" (expected name, targets)' }), 400);
    await expect(saveModelRoutes({ kept: { targets: ['p/a'] } })).rejects.toThrow('has unknown key "attmepts"');
  });

  test('falls back to the status when a refusal has no readable message', async () => {
    respond = () => new Response('internal', { status: 500 });
    await expect(saveModelRoutes({ kept: { targets: ['p/a'] } })).rejects.toThrow('Model pools request failed (500)');
  });
});

describe('saveModelRouteTuning', () => {
  test('sends null to remove the review settings so OpenCode defaults apply', async () => {
    respond = () => reply(JSON.stringify({ routes: {}, tuning: null }));
    expect(await saveModelRouteTuning(null)).toMatchObject({ tuning: null });
    expect(sent[0]).toMatchObject({ method: 'PUT', body: JSON.stringify({ tuning: null }) });
  });

  test('keeps the notes a user wrote by hand, in the request and in the saved state', async () => {
    const tuning = { enabled: true, windowHours: 12, notes: ['openai/gpt-6: reset at 2026-01-01T06:00:00Z'] };
    respond = (request) => reply(JSON.stringify({ routes: {}, tuning: JSON.parse(request.body).tuning }));
    const state = await saveModelRouteTuning(tuning);
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ tuning });
    expect(state.tuning).toEqual(tuning);
  });
});

describe('model pool schedules', () => {
  test('reads pool schedules and the list across pools, keeping fields the editor does not know', async () => {
    const routes = { kept: { targets: ['p/a'], schedules: [{ targets: ['p/*'], when: { daysOfWeek: ['mon', 1], start: '09:00' }, factor: 0.5 }] } };
    const schedules = [{ providers: ['p'], routes: ['kept'], when: { daysOfMonth: [-1] }, weight: 2, future: true }];
    respond = () => reply(JSON.stringify({ routes, tuning: null, schedules }));
    expect(await fetchModelRoutes()).toMatchObject({ routes, schedules, available: true });
  });

  test('loads a pool schedule without a window, so the editor shows it and the server names the problem', async () => {
    respond = () => reply(JSON.stringify({ routes: { kept: { targets: ['p/a'], schedules: [{ factor: 2 }] } }, schedules: null }));
    expect((await fetchModelRoutes()).routes.kept?.schedules).toEqual([{ factor: 2 }]);
  });

  test('saves the list across pools alone, and null removes it', async () => {
    const schedules = [{ models: ['*flash*'], when: {}, factor: 0.5 }];
    respond = (request) => reply(JSON.stringify({ routes: {}, schedules: JSON.parse(request.body).schedules }));
    expect((await saveModelRouteSchedules(schedules)).schedules).toEqual(schedules);
    expect(await saveModelRouteSchedules(null)).toMatchObject({ schedules: null });
    expect(sent.map((request) => request.body)).toEqual([JSON.stringify({ schedules }), JSON.stringify({ schedules: null })]);
  });
});

describe('fetchMessageModelAttribution', () => {
  test('reads per-message attribution for a session', async () => {
    respond = () => reply(JSON.stringify({
      available: true,
      messages: {
        msg_1: {
          providerID: 'github-copilot', modelID: 'gpt-6-luna', variant: 'low', routeID: 'fast-strong',
          selection: { mode: 'round-robin', reason: 'drawn' }, failover: null,
        },
      },
    }));
    const result = await fetchMessageModelAttribution('ses_1');
    expect(sent[0]).toMatchObject({ url: '/api/model-routes/turns?sessionID=ses_1', method: 'GET' });
    expect(result.messages?.msg_1).toMatchObject({ providerID: 'github-copilot', routeID: 'fast-strong' });
  });

  test('reports unavailable telemetry without throwing', async () => {
    respond = () => reply(JSON.stringify({ available: false, reason: 'no-database' }));
    expect(await fetchMessageModelAttribution('ses_1')).toEqual({ available: false, reason: 'no-database' });
  });

  test('throws the server message when the request fails', async () => {
    respond = () => reply(JSON.stringify({ error: 'sessionID is required' }), 400);
    await expect(fetchMessageModelAttribution('')).rejects.toThrow('sessionID is required');
  });
});
