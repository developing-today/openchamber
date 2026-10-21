import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  AUTONOMY_LEVELS,
  modelRouteProblems,
  modelRoutesProblems,
  readModelRoutes,
  registerModelRouteRoutes,
  reviewModelRoutesSave,
  validateModelRouteTuning,
} from './model-routes.js';

// The first problem a pool has, or null: what the validator returned before it reported every problem.
const validateModelRoute = (id, route) => modelRouteProblems(id, route)[0]?.message ?? null;

describe('validateModelRoute', () => {
  it('accepts a minimal ordered route', () => {
    expect(validateModelRoute('cheap-fast', { targets: ['openai/gpt-6-luna'] })).toBeNull();
  });

  it('accepts object targets, autonomy, selection and weights', () => {
    expect(
      validateModelRoute('luna', {
        targets: [{ model: 'openai/gpt-6-luna', defaultVariant: 'max' }, 'opencode-route/other'],
        autonomy: 'predictive',
        selection: 'weighted',
        weights: { 'openai/gpt-6-luna': 3 },
      }),
    ).toBeNull();
  });

  it('rejects bad ids, empty targets and unknown enums', () => {
    expect(validateModelRoute('bad id!', { targets: ['a/b'] })).toMatch(/invalid route id/);
    expect(validateModelRoute('x', { targets: [] })).toMatch(/at least one target/);
    expect(validateModelRoute('x', { targets: ['no-slash'] })).toMatch(/bad target/);
    expect(validateModelRoute('x', { targets: ['a/b'], autonomy: 'sentient' })).toMatch(/unknown autonomy/);
    expect(validateModelRoute('x', { targets: ['a/b'], selection: 'random' })).toMatch(/unknown selection/);
    expect(validateModelRoute('x', { targets: ['a/b'], weights: { 'a/b': 0 } })).toMatch(/positive number/);
  });

  it('reports nothing for a map of valid pools', () => {
    expect(modelRoutesProblems({ ok: { targets: ['a/b'] } })).toEqual({});
  });
});

describe('validateModelRoute advanced fields', () => {
  const base = { targets: ['a/b'] };

  it('accepts every field the OpenCode schema defines', () => {
    expect(
      validateModelRoute('full', {
        ...base,
        attempts: 2,
        hedgeAfterMs: 1500,
        selection: 'round-robin',
        health: {
          firstTokenTimeoutMs: false,
          maxResponseTimeMs: 60000,
          minOutputTokensPerSecond: 12.5,
          sampleWindow: 5,
          slowThreshold: 3,
          cooldownMs: 60000,
          quotaCooldownMs: 900000,
        },
        budgets: { 'a/b': { requestsPerMinute: 10, tokensPerDay: 1000000, softLimit: 0.9 } },
      }),
    ).toBeNull();
  });

  it('rejects out-of-range attempts, hedge and health values', () => {
    expect(validateModelRoute('x', { ...base, attempts: 0 })).toMatch(/attempts/);
    expect(validateModelRoute('x', { ...base, attempts: 51 })).toMatch(/attempts/);
    expect(validateModelRoute('x', { ...base, hedgeAfterMs: 0 })).toMatch(/hedgeAfterMs/);
    expect(validateModelRoute('x', { ...base, health: { cooldownMs: 1.5 } })).toMatch(/health\.cooldownMs/);
    expect(validateModelRoute('x', { ...base, health: { firstTokenTimeoutMs: 0 } })).toMatch(/firstTokenTimeoutMs/);
    expect(validateModelRoute('x', { ...base, health: { minOutputTokensPerSecond: 0 } })).toMatch(/minOutputTokensPerSecond/);
  });

  it('rejects malformed budgets', () => {
    expect(validateModelRoute('x', { ...base, budgets: { 'a/b': { requestsPerDay: -5 } } })).toMatch(/requestsPerDay/);
    expect(validateModelRoute('x', { ...base, budgets: { 'a/b': { softLimit: 1.5 } } })).toMatch(/softLimit/);
    expect(validateModelRoute('x', { ...base, budgets: ['a/b'] })).toMatch(/budgets/);
  });
});

describe('validateModelRoute target options and display name', () => {
  it('accepts a display name and target variant defaults and remaps', () => {
    expect(
      validateModelRoute('luna', {
        name: 'Luna pool',
        targets: [{ model: 'openai/gpt-6-luna', defaultVariant: 'max', variants: { low: 'high' }, until: 1893575040000 }],
      }),
    ).toBeNull();
  });

  it('rejects a non-string name, variant default or remap', () => {
    expect(validateModelRoute('luna', { name: 4, targets: ['openai/gpt-6-luna'] })).toMatch(/name must be a string/);
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', defaultVariant: 2 }] }),
    ).toMatch(/defaultVariant must be a string/);
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', variants: ['high'] }] }),
    ).toMatch(/variants must map/);
    expect(
      validateModelRoute('luna', { targets: [{ model: 'openai/gpt-6-luna', variants: { low: 3 } }] }),
    ).toMatch(/remap "low" must be a variant name or false/);
  });
});

describe('validateModelRouteTuning', () => {
  it('accepts partial tuning and rejects out-of-range values', () => {
    expect(validateModelRouteTuning({})).toBeNull();
    expect(validateModelRouteTuning({ enabled: true, intervalMinutes: 1440, windowHours: 336 })).toBeNull();
    expect(validateModelRouteTuning({ enabled: 'yes' })).toMatch(/enabled/);
    expect(validateModelRouteTuning({ intervalMinutes: 1441 })).toMatch(/intervalMinutes/);
    expect(validateModelRouteTuning({ windowHours: 0 })).toMatch(/windowHours/);
    expect(validateModelRouteTuning(null)).toMatch(/must be an object/);
  });
});

describe('readModelRoutes', () => {
  it('returns {} when experimental.model_routes is missing or not a map', () => {
    expect(readModelRoutes(null)).toEqual({});
    expect(readModelRoutes({})).toEqual({});
    expect(readModelRoutes({ experimental: { model_routes: ['x'] } })).toEqual({});
    expect(readModelRoutes({ experimental: { model_routes: { a: { targets: [] } } } })).toEqual({
      a: { targets: [] },
    });
  });
});

const makeApp = () => {
  const routes = { get: [], put: [] };
  return {
    routes,
    app: {
      get: (path, handler) => void routes.get.push([path, handler]),
      put: (...args) => void routes.put.push(args),
    },
  };
};

const res = () => {
  const out = {};
  return {
    out,
    status: (code) => {
      out.status = code;
      return { json: (body) => void (out.body = body) };
    },
    json: (body) => void (out.body = body),
  };
};

describe('registerModelRouteRoutes', () => {
  let targetConfig;
  let deps;

  beforeEach(() => {
    targetConfig = { experimental: { model_routes: { old: { targets: ['a/b'] } } } };
    deps = {
      readConfigLayers: vi.fn(() => ({ mergedConfig: targetConfig, paths: { userPath: '/u/opencode.json' } })),
      getConfigForPath: vi.fn(() => targetConfig),
      writeConfig: vi.fn(),
      CONFIG_FILE: '/u/opencode.json',
      isEnterpriseMode: () => false,
      refreshOpenCodeAfterConfigChange: vi.fn(async () => undefined),
    };
  });

  it('GET returns the merged routes and path', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.get[0][1]({}, response);
    expect(response.out.body).toEqual({ routes: { old: { targets: ['a/b'] } }, tuning: null, path: '/u/opencode.json', problems: {} });
  });

  it('PUT writes tuning alone and removes it when null', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const saved = res();
    await handler({ body: { tuning: { enabled: true, intervalMinutes: 30 } } }, saved);
    expect(targetConfig.experimental.model_routes).toEqual({ old: { targets: ['a/b'] } });
    expect(targetConfig.experimental.model_route_tuning).toEqual({ enabled: true, intervalMinutes: 30 });
    expect(saved.out.body.tuning).toEqual({ enabled: true, intervalMinutes: 30 });
    const removed = res();
    await handler({ body: { tuning: null } }, removed);
    expect(targetConfig.experimental.model_route_tuning).toBeUndefined();
    expect(removed.out.body.tuning).toBeNull();
  });

  it('PUT with neither routes nor tuning is a 400', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.put[0][3]({ body: {} }, response);
    expect(response.out.status).toBe(400);
  });

  it('PUT rejects out-of-range tuning', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.put[0][3]({ body: { tuning: { intervalMinutes: 0 } } }, response);
    expect(response.out.status).toBe(400);
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it('PUT validates, writes and refreshes', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    // [path, jsonParser, enterprise guard, handler]
    const [, , , handler] = routes.put[0];
    const response = res();
    await handler({ body: { routes: { luna: { targets: ['openai/x'], autonomy: 'agent' } } } }, response);
    expect(response.out.body.routes).toEqual({ luna: { targets: ['openai/x'], autonomy: 'agent' } });
    expect(targetConfig.experimental.model_routes).toEqual({ luna: { targets: ['openai/x'], autonomy: 'agent' } });
    expect(deps.writeConfig).toHaveBeenCalledWith(targetConfig, '/u/opencode.json');
    expect(deps.refreshOpenCodeAfterConfigChange).toHaveBeenCalledWith('model-routes');
  });

  it('PUT rejects invalid routes with 400 and writes nothing', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const response = res();
    await handler({ body: { routes: { x: { targets: [] } } } }, response);
    expect(response.out.status).toBe(400);
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it('PUT refuses routes that are not a map of pools', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const response = res();
    await handler({ body: { routes: ['a/b'] } }, response);
    expect(response.out).toEqual({ status: 400, body: { error: 'routes must be an object of route definitions' } });
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it('PUT parses its own body so saves never see undefined', () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    // Without a parser on this route the handler saw `req.body === undefined`
    // and every save failed while the UI showed an optimistic pool.
    expect(routes.put[0][1]?.name).toBe('jsonParser');
  });

  it('refuses writes in enterprise mode', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, { ...deps, isEnterpriseMode: () => true });
    const [, , guard] = routes.put[0];
    const response = res();
    let nextCalled = false;
    guard({}, response, () => void (nextCalled = true));
    expect(nextCalled).toBe(false);
    expect(response.out.status).toBe(403);
  });

  it('exposes every autonomy level the OpenCode schema accepts', () => {
    expect(AUTONOMY_LEVELS).toEqual(['fixed', 'rules', 'adaptive', 'predictive', 'agent']);
  });

  it('names an unknown key in a PUT and writes nothing', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const response = res();
    await handler({ body: { routes: { x: { targets: ['a/b'], attmepts: 2 } } } }, response);
    expect(response.out.status).toBe(400);
    expect(response.out.body.error).toMatch(/unknown key "attmepts"/);
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it('saves tuning notes as sent', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const notes = ['openai/gpt-6: reset at 2026-01-01T06:00:00Z'];
    const saved = res();
    await handler({ body: { tuning: { enabled: true, notes } } }, saved);
    expect(targetConfig.experimental.model_route_tuning).toEqual({ enabled: true, notes });
    expect(saved.out.body.tuning).toEqual({ enabled: true, notes });
  });

  it('PUT saves every pool when one of them carries a schedule', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const pools = {
      plain: { targets: ['a/b'] },
      peak: {
        targets: ['a/b', 'c/d'],
        schedules: [{ targets: ['c/*'], when: { daysOfWeek: ['mon'], start: '09:00', end: '17:00' }, factor: 0.5 }],
      },
    };
    const response = res();
    await handler({ body: { routes: pools } }, response);
    expect(response.out.status).toBeUndefined();
    expect(targetConfig.experimental.model_routes).toEqual(pools);
    expect(deps.writeConfig).toHaveBeenCalledWith(targetConfig, '/u/opencode.json');
  });

  it('PUT saves a changed pool that picks its models by pattern without force, and reports no problem for it', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const pools = {
      old: { targets: ['a/b'], variantRules: [{ match: 'claude and not *haiku*', map: { max: false } }] },
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
    };
    const response = res();
    await handler({ body: { routes: pools } }, response);
    expect(response.out.status).toBeUndefined();
    expect(targetConfig.experimental.model_routes).toEqual(pools);
    expect(deps.writeConfig).toHaveBeenCalledWith(targetConfig, '/u/opencode.json');
    expect(response.out.body.problems).toEqual({});
  });

  it('GET returns every pool and the problems of each one that has any, without refusing', async () => {
    targetConfig.experimental.model_routes = {
      good: { targets: ['a/b'] },
      // A JSONC `1e999` reads as Infinity.
      infinite: { targets: ['a/b'], weights: { 'a/b': Infinity } },
      empty: { targets: [] },
    };
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const response = res();
    await routes.get[0][1]({}, response);
    expect(response.out.status).toBeUndefined();
    expect(Object.keys(response.out.body.routes)).toEqual(['good', 'infinite', 'empty']);
    expect(response.out.body.problems).toEqual({
      infinite: [{ message: 'route "infinite" weight for "a/b" must be a positive number', skipsPool: true }],
      empty: [{ message: 'route "empty" needs at least one target, include or contains entry, or a match', skipsPool: false }],
    });
  });

  it('PUT writes a changed pool next to an unchanged one the validator refuses, which stays exactly as the config holds it', async () => {
    // Everything here is accepted by OpenCode and refused by OpenChamber's validator.
    const hand = {
      targets: [{ providerID: 'openai', model: 'gpt-6', variant: 'high' }, 'c/d'],
      autonomy: 'fixed',
      selection: 'weighted',
      weights: { 'x/y': 2 },
      health: { sampleWindow: 2, slowThreshold: 4 },
      note: 'written by hand',
    };
    targetConfig.experimental.model_routes = { hand, edited: { targets: ['a/b'] } };
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const response = res();
    await handler({ body: { routes: { hand: structuredClone(hand), edited: { targets: ['a/b', 'c/d'] } } } }, response);
    expect(response.out.status).toBeUndefined();
    expect(targetConfig.experimental.model_routes.hand).toBe(hand);
    expect(targetConfig.experimental.model_routes.edited).toEqual({ targets: ['a/b', 'c/d'] });
    expect(deps.writeConfig).toHaveBeenCalledWith(targetConfig, '/u/opencode.json');
    expect(Object.keys(response.out.body.problems)).toEqual(['hand']);
    expect(response.out.body.problems.hand).toHaveLength(5);
    expect(response.out.body.problems.hand.every(({ skipsPool }) => skipsPool === false)).toBe(true);
  });

  it('PUT refuses a changed pool with problems and names them per pool; force writes it and returns them', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const sent = { old: { targets: ['a/b'] }, bad: { targets: ['a/b'], attempts: 0 } };
    const problems = { bad: [{ message: 'route "bad" attempts must be a whole number from 1 to 50', skipsPool: true }] };

    const refused = res();
    await handler({ body: { routes: sent } }, refused);
    expect(refused.out).toEqual({ status: 400, body: { error: problems.bad[0].message, problems } });
    const notForced = res();
    await handler({ body: { routes: sent, force: 'true' } }, notForced);
    expect(notForced.out.status).toBe(400);
    expect(deps.writeConfig).not.toHaveBeenCalled();

    const forced = res();
    await handler({ body: { routes: sent, force: true } }, forced);
    expect(forced.out.status).toBeUndefined();
    expect(targetConfig.experimental.model_routes).toEqual(sent);
    expect(deps.writeConfig).toHaveBeenCalledWith(targetConfig, '/u/opencode.json');
    expect(forced.out.body.problems).toEqual(problems);
  });

  it('PUT counts a pool the client echoes back as unchanged although JSON turned Infinity into null', async () => {
    const infinite = { targets: ['a/b'], weights: { 'a/b': Infinity } };
    targetConfig.experimental.model_routes = { infinite };
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const echoed = JSON.parse(JSON.stringify(infinite));
    expect(echoed.weights['a/b']).toBeNull();
    const response = res();
    await handler({ body: { routes: { infinite: echoed, added: { targets: ['c/d'] } } } }, response);
    expect(response.out.status).toBeUndefined();
    expect(targetConfig.experimental.model_routes.infinite).toBe(infinite);
    expect(targetConfig.experimental.model_routes.added).toEqual({ targets: ['c/d'] });
  });
});

describe('reviewModelRoutesSave', () => {
  it('checks only the pools a save adds or changes, and keeps the stored copy of the rest', () => {
    const stored = { kept: { targets: [] } };
    const review = reviewModelRoutesSave({ kept: { targets: [] }, added: { targets: ['a/b'], attempts: 99 } }, stored);
    expect(review.routes.kept).toBe(stored.kept);
    expect(Object.keys(review.problems)).toEqual(['added']);
    const changed = reviewModelRoutesSave({ kept: { targets: [], name: 'renamed' } }, stored);
    expect(changed.problems.kept).toEqual([{ message: 'route "kept" needs at least one target, include or contains entry, or a match', skipsPool: false }]);
  });
});

describe('modelRouteProblems severity', () => {
  const skipsPool = (route) => modelRouteProblems('x', route).map((problem) => problem.skipsPool);

  it('marks what OpenCode loads anyway as a problem only OpenChamber has', () => {
    expect(skipsPool({ targets: ['a/b'], attmepts: 2 })).toEqual([false]);
    expect(skipsPool({ targets: [] })).toEqual([false]);
    expect(skipsPool({ targets: ['a/b'], health: { sampleWindow: 2, slowThreshold: 3 } })).toEqual([false]);
    expect(skipsPool({ targets: ['a/b'], weights: { 'c/d': 2 } })).toEqual([false]);
    expect(skipsPool({ targets: ['a/b'], autonomy: 'fixed', selection: 'weighted' })).toEqual([false]);
    expect(skipsPool({ targets: [{ model: 'a/b', defualtVariant: 'max' }] })).toEqual([false]);
    expect(skipsPool({ targets: ['a/b'], health: { sampleWindo: 5 }, budgets: { 'a/b': { requestsPerDayy: 5 } } })).toEqual([false, false]);
  });

  it('marks what OpenCode\'s schema refuses as skipping the pool', () => {
    expect(modelRouteProblems('bad id!', { targets: ['a/b'] })).toEqual([{ message: 'invalid route id "bad id!"', skipsPool: true }]);
    expect(skipsPool([])).toEqual([true]);
    expect(skipsPool({})).toEqual([true]);
    expect(skipsPool({ targets: ['no-slash'] })).toEqual([true]);
    expect(skipsPool({ targets: ['a/b'], name: 4 })).toEqual([true]);
    expect(skipsPool({ targets: ['a/b'], attempts: 0 })).toEqual([true]);
    expect(skipsPool({ targets: ['a/b'], autonomy: 'sentient' })).toEqual([true]);
    expect(skipsPool({ targets: [{ model: 'a/b', variants: { low: 3 } }] })).toEqual([true]);
    expect(skipsPool({ targets: ['a/b'], schedules: [{ factor: 0.5 }] })).toEqual([true]);
  });

  it('reports every problem in a pool, so one that skips it is not hidden behind one OpenCode accepts', () => {
    expect(skipsPool({ targets: ['a/b'], attmepts: 2, weights: { 'a/b': Infinity } })).toEqual([false, true]);
  });
});

describe('modelRouteProblems for the values OpenCode drops a pool for', () => {
  it('flags an infinite weight, an infinite minimum rate and a target until past Number.MAX_SAFE_INTEGER', () => {
    expect(modelRouteProblems('x', { targets: ['a/b'], weights: { 'a/b': Infinity } })).toEqual([
      { message: 'route "x" weight for "a/b" must be a positive number', skipsPool: true },
    ]);
    expect(modelRouteProblems('x', { targets: ['a/b'], health: { minOutputTokensPerSecond: Infinity } })).toEqual([
      { message: 'route "x" health.minOutputTokensPerSecond must be a positive number', skipsPool: true },
    ]);
    expect(modelRouteProblems('x', { targets: [{ model: 'a/b', until: Number.MAX_SAFE_INTEGER + 1 }] })).toEqual([
      { message: 'route "x" has a bad target: its until must be a positive epoch-millisecond time', skipsPool: true },
    ]);
  });

  it('still accepts the largest finite and safe values', () => {
    expect(modelRouteProblems('x', { targets: ['a/b'], weights: { 'a/b': Number.MAX_VALUE } })).toEqual([]);
    expect(modelRouteProblems('x', { targets: ['a/b'], health: { minOutputTokensPerSecond: Number.MAX_VALUE } })).toEqual([]);
    expect(modelRouteProblems('x', { targets: [{ model: 'a/b', until: Number.MAX_SAFE_INTEGER }] })).toEqual([]);
  });
});

describe('modelRouteProblems for OpenCode model selections', () => {
  it('flags a { providerID, model } target, which OpenCode accepts, as one OpenChamber does not check', () => {
    expect(modelRouteProblems('x', { targets: [{ providerID: 'openai', model: 'gpt-6', variant: 'high' }] })).toEqual([
      { message: 'route "x" target "openai/gpt-6" is written as { providerID, model }, which OpenChamber does not check', skipsPool: false },
    ]);
    expect(modelRouteProblems('x', { targets: [{ model: { providerID: 'openai', model: 'gpt-6' }, defaultVariant: 'max' }] })).toEqual([
      { message: 'route "x" target "openai/gpt-6" is written as { providerID, model }, which OpenChamber does not check', skipsPool: false },
    ]);
  });

  it('names a key OpenCode drops from a selection', () => {
    expect(modelRouteProblems('x', { targets: [{ providerID: 'openai', model: 'gpt-6', until: 1893575040000 }] })).toEqual([
      { message: expect.stringMatching(/is written as \{ providerID, model \}/), skipsPool: false },
      { message: expect.stringMatching(/has a bad target: unknown key "until" \(expected providerID, model, variant\)/), skipsPool: false },
    ]);
  });

  it('skips the pool when the selection is malformed, as OpenCode does', () => {
    expect(modelRouteProblems('x', { targets: [{ providerID: 'open/ai', model: 'gpt-6' }] }).some((problem) => problem.skipsPool)).toBe(true);
    expect(modelRouteProblems('x', { targets: [{ providerID: 'openai', model: 'gpt-6#a#b' }] }).some((problem) => problem.skipsPool)).toBe(true);
  });

  it('matches a weight keyed by the provider and model of a selection target', () => {
    const problems = modelRouteProblems('x', { targets: [{ providerID: 'openai', model: 'gpt-6', variant: 'high' }], weights: { 'openai/gpt-6': 2 } });
    expect(problems.map(({ message }) => message)).toEqual([expect.stringMatching(/is written as \{ providerID, model \}/)]);
  });
});

describe('validateModelRoute strictness', () => {
  const base = { targets: ['a/b'] };

  it('names an unknown key on the route, a target, a health block and a budget', () => {
    expect(validateModelRoute('x', { ...base, attmepts: 2 })).toMatch(/route "x" has unknown key "attmepts" \(expected name, targets/);
    expect(validateModelRoute('x', { targets: [{ model: 'a/b', defualtVariant: 'max' }] })).toMatch(/unknown key "defualtVariant"/);
    expect(validateModelRoute('x', { ...base, health: { sampleWindo: 5 } })).toMatch(/health has unknown key "sampleWindo"/);
    expect(validateModelRoute('x', { ...base, budgets: { 'a/b': { requestsPerDayy: 5 } } })).toMatch(/budget for "a\/b" has unknown key "requestsPerDayy"/);
  });

  it('refuses a weight for a target the route does not have', () => {
    expect(validateModelRoute('x', { targets: ['a/b', 'c/d'], weights: { 'a/b': 2, 'c/d': 1 } })).toBeNull();
    expect(validateModelRoute('x', { ...base, weights: { 'c/d': 2 } })).toMatch(/weight for "c\/d" matches no target/);
  });

  it('keys weights by the model without its variant, and does not accept a variant in the key', () => {
    expect(validateModelRoute('x', { targets: ['a/b#high'], weights: { 'a/b': 2 } })).toBeNull();
    expect(validateModelRoute('x', { targets: ['a/b#high'], weights: { 'a/b#high': 2 } })).toMatch(/matches no target/);
  });

  it('accepts a weight for a model a wildcard target matches, and refuses one it does not', () => {
    expect(validateModelRoute('x', { targets: ['openai/gpt-*'], weights: { 'openai/gpt-6-luna': 3 } })).toBeNull();
    expect(validateModelRoute('x', { targets: ['openai/gpt-*'], weights: { 'anthropic/gpt-6-luna': 3 } })).toMatch(/matches no target/);
    expect(validateModelRoute('x', { targets: ['openai/gpt-*'], weights: { 'openai/claude-5': 3 } })).toMatch(/matches no target/);
  });

  it('refuses selection modes that a fixed route would ignore', () => {
    expect(validateModelRoute('x', { ...base, autonomy: 'fixed', selection: 'weighted' })).toMatch(/is fixed.*"weighted" needs autonomy rules/);
    expect(validateModelRoute('x', { ...base, autonomy: 'fixed', selection: 'round-robin' })).toMatch(/"round-robin" needs autonomy rules/);
    expect(validateModelRoute('x', { ...base, autonomy: 'fixed', selection: 'ordered' })).toBeNull();
    expect(validateModelRoute('x', { ...base, autonomy: 'rules', selection: 'weighted' })).toBeNull();
    expect(validateModelRoute('x', { ...base, selection: 'weighted', weights: { 'a/b': 2 } })).toBeNull();
  });

  it('refuses a slow threshold larger than the window, using OpenCode defaults for unset values', () => {
    expect(validateModelRoute('x', { ...base, health: { sampleWindow: 2, slowThreshold: 3 } })).toMatch(/slowThreshold \(3\) cannot exceed health\.sampleWindow \(2\)/);
    expect(validateModelRoute('x', { ...base, health: { sampleWindow: 2 } })).toMatch(/slowThreshold \(3\) cannot exceed/);
    expect(validateModelRoute('x', { ...base, health: { sampleWindow: 3, slowThreshold: 3 } })).toBeNull();
    expect(validateModelRoute('x', { ...base, health: { slowThreshold: 6 } })).toMatch(/cannot exceed health\.sampleWindow \(5\)/);
    expect(validateModelRoute('x', { ...base, health: { slowThreshold: 5 } })).toBeNull();
    expect(validateModelRoute('x', { ...base, health: { slowThreshold: 4 } })).toBeNull();
  });
});

describe('validateModelRoute schedules', () => {
  const base = { targets: ['deepseek/v4', 'openai/gpt-6-luna'] };
  const peak = {
    id: 'peak',
    targets: ['deepseek/*'],
    when: {
      daysOfWeek: ['mon', 'friday', 3],
      daysOfMonth: [1, -1],
      start: '09:00',
      end: '17:00',
      timezone: 'America/Chicago',
      from: 1767225600000,
      until: 1893456000000,
    },
    factor: 0.5,
    note: 'DeepSeek is slow at peak hours',
  };
  const scheduled = (...schedules) => ({ ...base, schedules });
  const withWhen = (when) => scheduled({ when, factor: 0.5 });

  it('accepts a pool with a schedule, and the map that holds it', () => {
    expect(validateModelRoute('peak', scheduled(peak))).toBeNull();
    expect(validateModelRoute('peak', scheduled())).toBeNull();
    expect(modelRoutesProblems({ plain: { targets: ['a/b'] }, peak: scheduled(peak, { when: {}, weight: 2 }) })).toEqual({});
  });

  it('accepts a weight, both factor and weight, or neither, as OpenCode\'s schema does', () => {
    expect(validateModelRoute('peak', scheduled({ when: {}, weight: 2 }))).toBeNull();
    expect(validateModelRoute('peak', scheduled({ when: {}, factor: 0.5, weight: 2 }))).toBeNull();
    expect(validateModelRoute('peak', scheduled({ when: {} }))).toBeNull();
  });

  it('accepts day numbers, short and long day names, and a start time without a leading zero', () => {
    expect(validateModelRoute('peak', withWhen({ daysOfWeek: [0, 6, 'sunday', 'tues', 'thur', 'thurs'] }))).toBeNull();
    expect(validateModelRoute('peak', withWhen({ daysOfMonth: [31], start: '9:30', end: '17:00' }))).toBeNull();
  });

  it('refuses schedules that are not a list, and an entry that is not an object', () => {
    expect(validateModelRoute('peak', { ...base, schedules: {} })).toMatch(/route "peak" schedules must be a list/);
    expect(validateModelRoute('peak', scheduled(null))).toMatch(/route "peak" schedule 1 must be an object/);
  });

  it('names an unknown key on a schedule or its window, and which schedule has it', () => {
    expect(validateModelRoute('peak', scheduled(peak, { ...peak, enabled: true }))).toMatch(
      /route "peak" schedule 2 has unknown key "enabled" \(expected id, targets, when, factor, weight, note\)/,
    );
    // OpenCode would drop the misspelled key and apply the schedule on every day.
    expect(validateModelRoute('peak', withWhen({ dayOfWeek: ['mon'] }))).toMatch(/route "peak" schedule 1 when has unknown key "dayOfWeek"/);
  });

  it('refuses a missing or malformed when window', () => {
    expect(validateModelRoute('peak', scheduled({ factor: 0.5 }))).toMatch(/route "peak" schedule 1 needs a when window/);
    expect(validateModelRoute('peak', withWhen([]))).toMatch(/route "peak" schedule 1 when must be an object/);
    expect(validateModelRoute('peak', withWhen({ daysOfWeek: ['Mon'] }))).toMatch(/route "peak" schedule 1 when\.daysOfWeek must list lowercase day names/);
    expect(validateModelRoute('peak', withWhen({ daysOfWeek: [7] }))).toMatch(/when\.daysOfWeek/);
    expect(validateModelRoute('peak', withWhen({ daysOfWeek: 'mon' }))).toMatch(/when\.daysOfWeek/);
    expect(validateModelRoute('peak', withWhen({ daysOfMonth: [0] }))).toMatch(/route "peak" schedule 1 when\.daysOfMonth must list whole numbers from 1 to 31/);
    expect(validateModelRoute('peak', withWhen({ daysOfMonth: [-2] }))).toMatch(/when\.daysOfMonth/);
    expect(validateModelRoute('peak', withWhen({ start: 900 }))).toMatch(/route "peak" schedule 1 when\.start must be a string/);
    expect(validateModelRoute('peak', withWhen({ timezone: null }))).toMatch(/when\.timezone must be a string/);
    expect(validateModelRoute('peak', withWhen({ from: 0 }))).toMatch(/route "peak" schedule 1 when\.from must be a positive epoch-millisecond time/);
    expect(validateModelRoute('peak', withWhen({ until: 1.5 }))).toMatch(/when\.until/);
  });

  it('refuses a factor or weight that is not a positive number', () => {
    expect(validateModelRoute('peak', scheduled({ ...peak, factor: 0 }))).toMatch(/route "peak" schedule 1 factor must be a positive number/);
    expect(validateModelRoute('peak', scheduled({ ...peak, factor: '0.5' }))).toMatch(/factor must be a positive number/);
    expect(validateModelRoute('peak', scheduled({ ...peak, factor: Infinity }))).toMatch(/factor must be a positive number/);
    expect(validateModelRoute('peak', scheduled({ when: {}, weight: -1 }))).toMatch(/route "peak" schedule 1 weight must be a positive number/);
  });

  it('refuses targets that are not a list of strings, and an id or note that is not a string', () => {
    expect(validateModelRoute('peak', scheduled({ ...peak, targets: 'deepseek/*' }))).toMatch(/route "peak" schedule 1 targets must be a list of strings/);
    expect(validateModelRoute('peak', scheduled({ ...peak, targets: ['deepseek/*', 4] }))).toMatch(/targets must be a list of strings/);
    expect(validateModelRoute('peak', scheduled({ ...peak, id: 4 }))).toMatch(/route "peak" schedule 1 id must be a string/);
    expect(validateModelRoute('peak', scheduled({ ...peak, note: null }))).toMatch(/note must be a string/);
  });

  it('reports a bad schedule against its own pool only', () => {
    const problems = modelRoutesProblems({ plain: { targets: ['a/b'] }, peak: scheduled({ ...peak, factor: 0 }) });
    expect(Object.keys(problems)).toEqual(['peak']);
    expect(problems.peak).toEqual([{ message: expect.stringMatching(/^route "peak" schedule 1 factor/), skipsPool: true }]);
  });
});

describe('modelRouteProblems for the keys that pick models by pattern', () => {
  it('accepts each key OpenCode accepts, with or without targets', () => {
    expect(
      modelRoutesProblems({
        include: { include: ['*luna*', 'anthropic/*haiku*', 'small', 'opencode-route/small', 're:^openai/'] },
        contains: { contains: ['haiku', 'anthropic/', ' '] },
        match: { match: "(*luna* or *haiku*) and not 're:-(5|6)$' and not *mini*" },
        mixed: { targets: ['openai/argon'], include: ['*luna*'], exclude: ['*-5', 'frontier-direct'], notContains: ['old'] },
        emptyTargets: { targets: [], match: '*luna*' },
        levels: { targets: ['a/b'], levels: ['low', 'medium', 'high'] },
        rules: {
          targets: ['a/b'],
          variantRules: [{ match: '*', map: { max: 'high' } }, { match: 'claude and not *haiku*', map: { max: false } }],
        },
        sitOut: { targets: [{ model: 'openai/argon', variants: { xhigh: 'high', max: false } }, 'anthropic/claude-opus-5'] },
      }),
    ).toEqual({});
  });

  it('skips a pool with none of targets, include, contains and match, as OpenCode does', () => {
    const skipped = [{ message: 'route "x" has no targets, include, contains or match', skipsPool: true }];
    expect(modelRouteProblems('x', {})).toEqual(skipped);
    expect(modelRouteProblems('x', { exclude: ['*-mini'], levels: ['low'] })).toEqual(skipped);
  });

  it('flags a pool whose lists are all empty, which OpenCode loads with no models', () => {
    const flagged = [{ message: 'route "x" needs at least one target, include or contains entry, or a match', skipsPool: false }];
    expect(modelRouteProblems('x', { targets: [] })).toEqual(flagged);
    expect(modelRouteProblems('x', { include: [] })).toEqual(flagged);
    expect(modelRouteProblems('x', { targets: [], include: [], contains: [] })).toEqual(flagged);
    expect(modelRouteProblems('x', { targets: [], contains: ['haiku'] })).toEqual([]);
  });

  it('skips the pool for a malformed entry, regular expression or expression, and names where it is', () => {
    // The skipped pools of the fork's normalization test (packages/core/test/config/normalization.test.ts).
    expect(modelRouteProblems('regex', { include: ['*luna*'], exclude: ['re:luna-(5'] })).toEqual([
      { message: expect.stringMatching(/^route "regex" exclude entry 1 "re:luna-\(5": Invalid regular expression/), skipsPool: true },
    ]);
    expect(modelRouteProblems('expression', { match: '*luna* xor *haiku*' })).toEqual([
      { message: 'route "expression" match "*luna* xor *haiku*": xor is not supported: write (a or b) and not (a and b)', skipsPool: true },
    ]);
    expect(modelRouteProblems('rule', { targets: ['openai/argon'], variantRules: [{ match: '(*argon*', map: { max: false } }] })).toEqual([
      { message: 'route "rule" variant rule 1 match "(*argon*": missing ")" before the end', skipsPool: true },
    ]);
    expect(modelRouteProblems('empty', { include: ['*luna*'], contains: [''] })).toEqual([
      { message: 'route "empty" contains entry 1 "": empty text, which would match every model', skipsPool: true },
    ]);
    expect(modelRouteProblems('x', { targets: ['a/b'], include: ['*luna*', 're:'], exclude: [''], notContains: [''] })).toEqual([
      { message: 'route "x" include entry 2 "re:": empty pattern', skipsPool: true },
      { message: 'route "x" exclude entry 1 "": empty pattern', skipsPool: true },
      { message: 'route "x" notContains entry 1 "": empty text, which would match every model', skipsPool: true },
    ]);
  });

  it('skips the pool for a value of a type OpenCode\'s schema refuses', () => {
    const problemsWith = (keys) => modelRouteProblems('x', { targets: ['a/b'], ...keys });
    const skipped = (message) => [{ message, skipsPool: true }];
    expect(problemsWith({ include: 'x' })).toEqual(skipped('route "x" include must be a list of strings'));
    expect(problemsWith({ exclude: { a: 1 } })).toEqual(skipped('route "x" exclude must be a list of strings'));
    expect(problemsWith({ contains: [1] })).toEqual(skipped('route "x" contains must be a list of strings'));
    expect(problemsWith({ notContains: null })).toEqual(skipped('route "x" notContains must be a list of strings'));
    expect(problemsWith({ match: 5 })).toEqual(skipped('route "x" match must be a string'));
    expect(problemsWith({ levels: 'low' })).toEqual(skipped('route "x" levels must be a list of strings'));
    expect(problemsWith({ levels: [1] })).toEqual(skipped('route "x" levels must be a list of strings'));
    expect(problemsWith({ variantRules: {} })).toEqual(skipped('route "x" variantRules must be a list'));
    expect(problemsWith({ variantRules: [null] })).toEqual(skipped('route "x" variant rule 1 must be an object'));
    expect(problemsWith({ variantRules: [{ map: { max: false } }] })).toEqual(skipped('route "x" variant rule 1 needs a match'));
    expect(problemsWith({ variantRules: [{ match: '*' }] })).toEqual(skipped('route "x" variant rule 1 needs a map'));
    expect(problemsWith({ variantRules: [{ match: 5, map: {} }] })).toEqual(skipped('route "x" variant rule 1 match must be a string'));
    expect(problemsWith({ variantRules: [{ match: '*', map: [] }] })).toEqual(skipped('route "x" variant rule 1 map must map levels to a variant name or false'));
    expect(problemsWith({ variantRules: [{ match: '*', map: { max: true } }] })).toEqual(skipped('route "x" variant rule 1 map "max" must be a variant name or false'));
    expect(modelRouteProblems('x', { targets: [{ model: 'a/b', variants: { max: true } }] })).toEqual(
      skipped('route "x" has a bad target: its variant remap "max" must be a variant name or false'),
    );
    expect(modelRouteProblems('x', { targets: 'a/b' })).toEqual(skipped('route "x" targets must be a list'));
  });

  it('flags an unknown key on a variant rule, which OpenCode drops', () => {
    expect(modelRouteProblems('x', { targets: ['a/b'], variantRules: [{ match: '*', map: {}, extra: 1 }] })).toEqual([
      { message: 'route "x" variant rule 1 has unknown key "extra" (expected match, map)', skipsPool: false },
    ]);
  });

  it('does not check the weights of a pool that takes models by pattern against its targets', () => {
    expect(modelRouteProblems('x', { include: ['*luna*'], selection: 'weighted', weights: { 'openai/gpt-6-luna': 3 } })).toEqual([]);
    expect(modelRouteProblems('x', { targets: ['a/b'], contains: ['luna'], weights: { 'openai/gpt-6-luna': 3 } })).toEqual([]);
    expect(modelRouteProblems('x', { targets: ['a/b'], match: '*luna*', weights: { 'openai/gpt-6-luna': Infinity } })).toEqual([
      { message: 'route "x" weight for "openai/gpt-6-luna" must be a positive number', skipsPool: true },
    ]);
  });
});

// What the fork's own `ModelRouteMatch.problems({ match })` answers for each expression
// (packages/core/src/model-route-match.ts on routing-docs-and-diagnostics at 353bb23676, run with
// bun 1.4.2): null where it accepts the expression, else its message. A regular expression's
// message comes from the JavaScript engine, Bun's there and Node's here, so for those only the
// start both engines share is pinned.
const INVALID_REGEX = 'Invalid regular expression';
const FORK_EXPRESSION_VERDICTS = [
  // The fork's own cases (packages/core/test/model-route-match.test.ts).
  ['a or b and not c', null],
  ["(A OR b) AND NOT 'and'", null],
  [`'re:gpt-(5|6)$' or "* 6"`, null],
  ['', 'empty expression'],
  ['   ', 'empty expression'],
  ['a and', 'expected a pattern or pool name, found the end'],
  ['and a', 'expected a pattern or pool name, found "and"'],
  ['not', 'expected a pattern or pool name, found the end'],
  ['(a or b', 'missing ")" before the end'],
  ['a or b)', 'unmatched ")"'],
  ['a b', 'expected "and" or "or" before "b"'],
  ['a xor b', 'xor is not supported: write (a or b) and not (a and b)'],
  ["'re:gpt-(5", "unclosed quote in 're:gpt-"],
  ["(*luna* or *haiku*) and not 're:-(5|6)$'", null],
  ["*luna* or 're:luna-(5'", INVALID_REGEX],
  ['*sonnet* and not *-old', null],
  // More cases, answered by the same function.
  ['()', 'expected a pattern or pool name, found ")"'],
  [')', 'expected a pattern or pool name, found ")"'],
  ['a and (b c)', 'missing ")" before "c"'],
  ['(a xor b)', 'missing ")" before "xor"'],
  ['(a))', 'unmatched ")"'],
  ['xor', null],
  ['a or xor', null],
  ['a XoR b', 'xor is not supported: write (a or b) and not (a and b)'],
  ['NOT a', null],
  ['not not a', null],
  ['a AND b OR c', null],
  ['not (a or b) and c', null],
  ['a or (b and (c or not d))', null],
  ['a and or b', 'expected a pattern or pool name, found "or"'],
  ['a not b', 'expected "and" or "or" before "not"'],
  ['a\tor\nb', null],
  ["'and'", null],
  [`'(' or ")"`, null],
  ["'", "unclosed quote in '"],
  ['"abc', 'unclosed quote in "abc'],
  ["a and 'b", "unclosed quote in 'b"],
  ["abc'def'", null],
  ["'abc'def", 'expected "and" or "or" before "def"'],
  ["''", 'empty pattern'],
  ['a or ""', 'empty pattern'],
  ["'re:'", 'empty pattern'],
  ['re:', 'empty pattern'],
  ['opencode-route/claude and not *haiku*', null],
  ['re:^q/', null],
  ['re:luna-(5|6)$', 'expected "and" or "or" before "("'],
  ['re:(', 'expected "and" or "or" before "("'],
  ["'re:('", INVALID_REGEX],
  ['re:a{2,1}', INVALID_REGEX],
  ['re:a**', INVALID_REGEX],
  ['re:[z-a]', INVALID_REGEX],
  ["x and 're:a{2,1}'", INVALID_REGEX],
  ["'re:(?<a>x)(?<a>y)'", INVALID_REGEX],
  ["'re:(?i:a)'", null],
  ["'re:(?<=a)b'", null],
  ['re:\\p{L}', null],
];

describe('match expressions', () => {
  it('reads each sample expression as the fork does', () => {
    for (const [source, verdict] of FORK_EXPRESSION_VERDICTS) {
      const problems = modelRouteProblems('x', { targets: ['a/b'], match: source });
      const message = `route "x" match "${source}": ${verdict}`;
      if (verdict === null) expect(problems, source).toEqual([]);
      else if (verdict === INVALID_REGEX) expect(problems, source).toEqual([{ message: expect.stringContaining(message), skipsPool: true }]);
      else expect(problems, source).toEqual([{ message, skipsPool: true }]);
    }
  });

  it('reads a variant rule\'s match the same way', () => {
    expect(modelRouteProblems('x', { targets: ['a/b'], variantRules: [{ match: "claude and not 're:haiku-(5|6)'", map: { max: false } }] })).toEqual([]);
    expect(modelRouteProblems('x', { targets: ['a/b'], variantRules: [{ match: 'x and', map: {} }] })).toEqual([
      { message: 'route "x" variant rule 1 match "x and": expected a pattern or pool name, found the end', skipsPool: true },
    ]);
  });
});

describe('validateModelRouteTuning strictness', () => {
  it('names an unknown tuning key', () => {
    expect(validateModelRouteTuning({ enabled: true, intervalMinute: 5 })).toMatch(/tuning has unknown key "intervalMinute"/);
  });

  it('accepts notes written as `match: text` lines', () => {
    expect(
      validateModelRouteTuning({
        enabled: true,
        notes: ['openai/gpt-6: reset at 2026-01-01T06:00:00Z', 'anthropic: back in 3 hours'],
      }),
    ).toBeNull();
  });

  it('accepts a later colon in the text, and refuses a line with nothing before its colon or nothing after it', () => {
    expect(validateModelRouteTuning({ notes: ['match: text'] })).toBeNull();
    expect(validateModelRouteTuning({ notes: ['x::y'] })).toBeNull();
    expect(validateModelRouteTuning({ notes: [':x:y'] })).toMatch(/line 1 must read "match: text"/);
    expect(validateModelRouteTuning({ notes: ['x:'] })).toMatch(/line 1 must read "match: text"/);
  });

  it('refuses notes that are not a list of strings, or whose lines OpenCode would drop', () => {
    expect(validateModelRouteTuning({ notes: 'openai: back in 3 hours' })).toMatch(/notes must be a list of strings/);
    expect(validateModelRouteTuning({ notes: [3] })).toMatch(/notes must be a list of strings/);
    expect(validateModelRouteTuning({ notes: ['openai back in 3 hours'] })).toMatch(/line 1 must read "match: text"/);
    expect(validateModelRouteTuning({ notes: ['ok: fine', ': no match'] })).toMatch(/line 2 must read/);
    expect(validateModelRouteTuning({ notes: ['openai:   '] })).toMatch(/line 1 must read/);
    expect(validateModelRouteTuning({ notes: ['openai: back\nin 3 hours'] })).toMatch(/line 1 must read "match: text" on one line/);
    expect(validateModelRouteTuning({ notes: [{ match: 'openai', text: 'back' }] })).toMatch(/notes must be a list of strings/);
  });
});
