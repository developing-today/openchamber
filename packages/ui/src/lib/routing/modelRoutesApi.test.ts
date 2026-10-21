import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import type { ModelRoute, ModelRouteEntry } from './modelRoutesApi';
import { fetchMessageModelAttribution, fetchModelRoutes, readModelRouteJsonText, saveModelRouteTuning, saveModelRoutes } from './modelRoutesApi';

type Sent = { url: string; method: string; body: string };

const sent: Sent[] = [];
let respond: (request: Sent) => Response = () => new Response('', { status: 500 });

const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

const editable = (route: ModelRoute): ModelRouteEntry => ({ kind: 'editable', route });

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
    expect(await fetchModelRoutes()).toEqual({ routes: {}, problems: {}, tuning: null, available: false });
  });

  test('reads the merged routes and the review settings', async () => {
    respond = () => reply(JSON.stringify({ routes: { kept: { targets: ['p/a'] } }, tuning: { enabled: true }, path: '/u/opencode.json' }));
    expect(await fetchModelRoutes()).toMatchObject({
      routes: { kept: { kind: 'editable', route: { targets: ['p/a'] } } },
      tuning: { enabled: true },
      problems: {},
      available: true,
    });
    expect(sent[0]).toMatchObject({ url: '/api/model-routes', method: 'GET' });
  });

  test('keeps a pool the editor cannot model as its JSON, with where the editor stopped, beside the pools it can', async () => {
    const routes = {
      kept: { targets: ['p/a'] },
      named: { name: 4, targets: ['p/a'] },
      typo: { targets: ['p/a'], attmepts: 2 },
      remap: { targets: [{ model: 'p/a', variants: { low: 3 } }] },
      text: 'p/a',
    };
    respond = () => reply(JSON.stringify({ routes }));
    const state = await fetchModelRoutes();
    expect(state.routes).toEqual({
      kept: { kind: 'editable', route: { targets: ['p/a'] } },
      named: { kind: 'json', json: routes.named, unreadablePath: 'name' },
      typo: { kind: 'json', json: routes.typo, unreadablePath: 'attmepts' },
      remap: { kind: 'json', json: routes.remap, unreadablePath: 'targets[0].variants.low' },
      text: { kind: 'json', json: 'p/a', unreadablePath: '' },
    });
  });

  test('reads the problems the server found per pool', async () => {
    const problems = { kept: [{ message: 'route "kept" needs at least one target, include or contains entry, or a match', skipsPool: false }] };
    respond = () => reply(JSON.stringify({ routes: { kept: { targets: [] } }, problems }));
    expect((await fetchModelRoutes()).problems).toEqual(problems);
  });

  test('keeps the pools when the review settings cannot be read, and marks the settings unreadable', async () => {
    respond = () => reply(JSON.stringify({ routes: { kept: { targets: ['p/a'] } }, tuning: { enabled: 'yes' } }));
    const state = await fetchModelRoutes();
    expect(state.tuning).toBe('unreadable');
    expect(state.routes.kept).toEqual({ kind: 'editable', route: { targets: ['p/a'] } });
  });
});

describe('saveModelRoutes', () => {
  test('sends the whole route map in one PUT and returns the saved state', async () => {
    const routes = { kept: { targets: ['p/a', 'p/b'], selection: 'weighted', weights: { 'p/a': 2 } } } satisfies Record<string, ModelRoute>;
    respond = (request) => reply(request.body);
    const result = await saveModelRoutes({ kept: editable(routes.kept) });
    expect(sent).toEqual([{ url: '/api/model-routes', method: 'PUT', body: JSON.stringify({ routes }) }]);
    expect(result).toMatchObject({ kind: 'saved', state: { routes: { kept: editable(routes.kept) }, available: true } });
  });

  test('sends back a pool schedule the client does not model, as it was read', async () => {
    const routes = {
      peak: {
        targets: ['p/a', 'p/b'],
        schedules: [{ targets: ['p/b'], when: { daysOfWeek: ['mon'], start: '09:00', end: '17:00' }, factor: 0.5 }],
      },
    } satisfies Record<string, ModelRoute>;
    respond = () => reply(JSON.stringify({ routes }));
    const read = await fetchModelRoutes();
    expect(read.routes).toEqual({ peak: editable(routes.peak) });
    respond = (request) => reply(request.body);
    await saveModelRoutes(read.routes);
    expect(JSON.parse(sent[1]?.body ?? '')).toEqual({ routes });
  });

  test('a pool the editor cannot model hides no other pool, and goes back exactly as it was read', async () => {
    const routes = {
      first: { targets: ['p/a'] },
      hand: { name: 4, targets: ['p/a', 7], extra: { nested: [1, null, 'x'] } },
      last: { targets: ['p/b'], autonomy: 'rules' },
    };
    respond = () => reply(JSON.stringify({ routes }));
    const read = await fetchModelRoutes();
    expect(Object.keys(read.routes)).toEqual(['first', 'hand', 'last']);
    expect(read.routes.first).toEqual(editable(routes.first));
    expect(read.routes.last).toEqual(editable({ targets: ['p/b'], autonomy: 'rules' }));
    expect(read.routes.hand).toMatchObject({ kind: 'json', json: routes.hand });
    respond = (request) => reply(request.body);
    await saveModelRoutes(read.routes);
    expect(JSON.parse(sent[1]?.body ?? '')).toEqual({ routes });
  });

  test('a target object with an unknown key, and a { providerID, model } target, go back unchanged', async () => {
    const routes = {
      extra: { targets: [{ model: 'p/a', defaultVariant: 'max', priority: 1 }] },
      selection: { targets: [{ providerID: 'openai', model: 'gpt-6', variant: 'high' }, 'p/b'] },
      nested: { targets: [{ model: { providerID: 'openai', model: 'gpt-6' }, defaultVariant: 'max' }] },
    };
    respond = () => reply(JSON.stringify({ routes }));
    const read = await fetchModelRoutes();
    expect(read.routes).toMatchObject({
      extra: { kind: 'json', unreadablePath: 'targets[0].priority' },
      selection: { kind: 'json', unreadablePath: 'targets[0].providerID' },
      nested: { kind: 'json', unreadablePath: 'targets[0].model' },
    });
    respond = (request) => reply(request.body);
    await saveModelRoutes(read.routes);
    expect(JSON.parse(sent[1]?.body ?? '')).toEqual({ routes });
  });

  test('reads a pool that picks its models by pattern as editable, and sends it back unchanged', async () => {
    const routes = {
      small: {
        include: ['*luna*', '*haiku*'],
        exclude: ['*-5', 're:-mini$'],
        contains: ['flash'],
        notContains: ['preview'],
        match: "(*luna* or 're:haiku-(5|6)') and not *old*",
        levels: ['low', 'medium', 'high'],
        variantRules: [{ match: '*argon*', map: { xhigh: 'high', max: false } }],
        selection: 'weighted',
        weights: { 'openai/gpt-6-luna': 3 },
      },
      big: { targets: [{ model: 'openai/argon', variants: { xhigh: 'high', max: false } }, 'anthropic/claude-opus-5'], levels: [] },
    } satisfies Record<string, ModelRoute>;
    respond = () => reply(JSON.stringify({ routes }));
    const read = await fetchModelRoutes();
    expect(read.routes).toEqual({ small: editable(routes.small), big: editable(routes.big) });
    respond = (request) => reply(request.body);
    await saveModelRoutes(read.routes);
    expect(JSON.parse(sent[1]?.body ?? '')).toEqual({ routes });
  });

  test('a pool with a key or value the matching keys do not define stays JSON and goes back unchanged', async () => {
    const routes = {
      misspelled: { include: ['*luna*'], includes: ['*haiku*'] },
      rule: { include: ['*luna*'], variantRules: [{ match: '*', map: {}, extra: 1 }] },
      remap: { targets: [{ model: 'p/a', variants: { max: true } }] },
      levels: { targets: ['p/a'], levels: 'low' },
    };
    respond = () => reply(JSON.stringify({ routes }));
    const read = await fetchModelRoutes();
    expect(read.routes).toMatchObject({
      misspelled: { kind: 'json', unreadablePath: 'includes' },
      rule: { kind: 'json', unreadablePath: 'variantRules[0].extra' },
      remap: { kind: 'json', unreadablePath: 'targets[0].variants.max' },
      levels: { kind: 'json', unreadablePath: 'levels' },
    });
    respond = (request) => reply(request.body);
    await saveModelRoutes(read.routes);
    expect(JSON.parse(sent[1]?.body ?? '')).toEqual({ routes });
  });

  test('returns the problems per pool when the server refuses the save, and force sends it again', async () => {
    const problems = { bad: [{ message: 'route "bad" attempts must be a whole number from 1 to 50', skipsPool: true }] };
    const routes = { bad: editable({ targets: ['p/a'], attempts: 0 }) };
    respond = () => reply(JSON.stringify({ error: problems.bad[0].message, problems }), 400);
    expect(await saveModelRoutes(routes)).toEqual({ kind: 'refused', problems });
    respond = (request) => reply(JSON.stringify({ routes: JSON.parse(request.body).routes, problems }));
    const forced = await saveModelRoutes(routes, { force: true });
    expect(JSON.parse(sent[1]?.body ?? '')).toEqual({ routes: { bad: { targets: ['p/a'], attempts: 0 } }, force: true });
    expect(forced).toMatchObject({ kind: 'saved', state: { problems } });
  });

  test('throws the server message when the save fails without naming pools', async () => {
    respond = () => reply(JSON.stringify({ error: 'routes must be an object of route definitions' }), 400);
    await expect(saveModelRoutes({ kept: editable({ targets: ['p/a'] }) })).rejects.toThrow('routes must be an object of route definitions');
  });

  test('falls back to the status when a refusal has no readable message', async () => {
    respond = () => new Response('internal', { status: 500 });
    await expect(saveModelRoutes({ kept: editable({ targets: ['p/a'] }) })).rejects.toThrow('Model pools request failed (500)');
  });
});

describe('readModelRouteJsonText', () => {
  test('reads JSON the editor can model as editable and anything else as JSON, and refuses text that is not JSON', () => {
    expect(readModelRouteJsonText('{"targets":["p/a"]}')).toEqual(editable({ targets: ['p/a'] }));
    expect(readModelRouteJsonText('{"targets":"p/a"}')).toEqual({ kind: 'json', json: { targets: 'p/a' }, unreadablePath: 'targets' });
    expect(() => readModelRouteJsonText('{"targets":')).toThrow();
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
