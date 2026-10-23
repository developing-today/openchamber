import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  AUTONOMY_LEVELS,
  readModelRoutes,
  registerModelRouteRoutes,
  validateModelRoute,
  validateModelRouteTuning,
  validateModelRoutes,
} from './model-routes.js';

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

  it('rejects a non-object map', () => {
    expect(validateModelRoutes(null)).toMatch(/must be an object/);
    expect(validateModelRoutes({ ok: { targets: ['a/b'] } })).toBeNull();
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
        schedules: [{ when: { daysOfWeek: ['mon'], start: '09:00', end: '17:00' }, factor: 0.5 }],
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

  it('refuses non-finite weights and health rates, which OpenCode requires to be finite', () => {
    expect(validateModelRoute('x', { ...base, weights: { 'a/b': Infinity } })).toMatch(/weight for "a\/b" must be a positive number/);
    // The realistic spelling: an overflowing JSON number parses to Infinity.
    expect(validateModelRoute('x', { ...base, weights: { 'a/b': JSON.parse('1e999') } })).toMatch(/positive number/);
    expect(validateModelRoute('x', { ...base, health: { minOutputTokensPerSecond: Infinity } })).toMatch(/minOutputTokensPerSecond must be a positive number/);
    expect(validateModelRoute('x', { ...base, weights: { 'a/b': 2 }, health: { minOutputTokensPerSecond: 12.5 } })).toBeNull();
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
    ).toMatch(/remap "low" must be a string/);
  });
});

describe('validateModelRoute schedules', () => {
  const base = { targets: ['deepseek/v4', 'openai/x'] };

  it('accepts the reported hand-written schedule beside a pool without one', () => {
    expect(
      validateModelRoutes({
        other: { targets: ['openai/x'] },
        peak: {
          targets: ['deepseek/v4'],
          schedules: [{ when: { daysOfWeek: ['mon'], start: '09:00', end: '17:00' }, factor: 0.5 }],
        },
      }),
    ).toBeNull();
  });

  it('accepts a full schedule: id, target patterns, a weight, a note and every window field', () => {
    expect(
      validateModelRoute('peak', {
        ...base,
        schedules: [
          {
            id: 'weekday-peak',
            targets: ['deepseek/*'],
            when: {
              daysOfWeek: ['monday', 2, 'tues'],
              daysOfMonth: [1, -1],
              start: '9:00',
              end: '17:00:30',
              timezone: 'America/Chicago',
              from: 1893456000000,
              until: 1896134400000,
            },
            weight: 2.5,
            note: 'deepseek is busy in the morning',
          },
          { when: {}, factor: 1 },
        ],
      }),
    ).toBeNull();
  });

  it('refuses a schedule that is not a list of objects, or carries an unknown key', () => {
    expect(validateModelRoute('x', { ...base, schedules: { when: {} } })).toMatch(/schedules must be a list/);
    expect(validateModelRoute('x', { ...base, schedules: ['peak'] })).toMatch(/schedule 1 must be an object/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 1, factr: 2 }] })).toMatch(
      /schedule 1 has unknown key "factr" \(expected id, targets, when, factor, weight, note\)/,
    );
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 1, id: 3 }] })).toMatch(/schedule 1 id must be a string/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 1, note: 3 }] })).toMatch(/schedule 1 note must be a string/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 1, targets: 'deepseek/*' }] })).toMatch(/targets must be a list/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 1, targets: ['  '] }] })).toMatch(/non-empty target references/);
  });

  it('refuses a schedule target that matches no target in the route, and an empty targets list', () => {
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: ['anthropic/claude-sonnet-4-6'] }] })).toMatch(
      /schedule 1 target "anthropic\/claude-sonnet-4-6" matches no target in the route/,
    );
    expect(
      validateModelRoute('x', {
        ...base,
        schedules: [
          { when: {}, factor: 2, targets: ['deepseek/v4'] },
          { when: {}, factor: 2, targets: ['openai/y'] },
        ],
      }),
    ).toMatch(/schedule 2 target "openai\/y" matches no target in the route/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: [] }] })).toMatch(
      /targets must not be empty: OpenCode applies a schedule with an empty targets list to every target/,
    );
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: ['deepseek/v4'] }] })).toBeNull();
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2, targets: ['deepseek/*'] }] })).toBeNull();
    expect(
      validateModelRoute('x', { targets: ['openai/gpt-*'], schedules: [{ when: {}, factor: 2, targets: ['openai/gpt-6-luna'] }] }),
    ).toBeNull();
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 2 }] })).toBeNull();
  });

  it('accepts a schedule target pattern that partly overlaps a route target pattern, and refuses disjoint patterns', () => {
    const withTargets = (targets, entry) =>
      validateModelRoute('x', { targets, schedules: [{ when: {}, factor: 2, targets: [entry] }] });
    // openai/gpt-6-luna matches both patterns, so the schedule can apply.
    expect(withTargets(['openai/*-luna'], 'openai/gpt-*')).toBeNull();
    expect(withTargets(['openai/gpt-*'], 'openai/*-luna')).toBeNull();
    expect(withTargets([{ model: 'openai/*-luna' }], 'openai/gpt-*')).toBeNull();
    expect(withTargets(['openai/*-luna'], 'openai/gpt-*#high')).toBeNull();
    expect(withTargets(['openai/gpt-*-luna'], 'openai/*-6-*')).toBeNull();
    expect(withTargets(['anthropic/*'], 'openai/gpt-*')).toMatch(/schedule 1 target "openai\/gpt-\*" matches no target in the route/);
    expect(withTargets(['openai/claude-*'], 'openai/gpt-*')).toMatch(/matches no target in the route/);
    expect(withTargets(['openai/*-luna'], 'openai/*-sol')).toMatch(/matches no target in the route/);
  });

  it('refuses a schedule with no window, no change, or both changes', () => {
    expect(validateModelRoute('x', { ...base, schedules: [{ factor: 0.5 }] })).toMatch(/needs a when window/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: 'weekdays' }] })).toMatch(/needs a when window/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {} }] })).toMatch(/needs a factor or a weight/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 0.5, weight: 2 }] })).toMatch(/both factor and weight/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: 0 }] })).toMatch(/factor must be a positive number/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, weight: -1 }] })).toMatch(/weight must be a positive number/);
    expect(validateModelRoute('x', { ...base, schedules: [{ when: {}, factor: '0.5' }] })).toMatch(/factor must be a positive number/);
  });

  it('refuses window values OpenCode cannot read, because its parser drops the whole schedule', () => {
    const withWindow = (when) => validateModelRoute('x', { ...base, schedules: [{ when, factor: 0.5 }] });
    expect(withWindow({ daysOfWeek: ['funday'] })).toMatch(/daysOfWeek entry "funday"/);
    expect(withWindow({ daysOfWeek: ['Mon'] })).toMatch(/daysOfWeek entry "Mon"/);
    expect(withWindow({ daysOfWeek: [7] })).toMatch(/daysOfWeek entry "7"/);
    expect(withWindow({ daysOfWeek: 'mon' })).toMatch(/daysOfWeek must be a list/);
    expect(withWindow({ daysOfWeek: [] })).toMatch(/daysOfWeek must not be empty/);
    expect(withWindow({ daysOfMonth: [0] })).toMatch(/daysOfMonth entry "0"/);
    expect(withWindow({ daysOfMonth: [32] })).toMatch(/daysOfMonth entry "32"/);
    expect(withWindow({ daysOfMonth: [] })).toMatch(/daysOfMonth must not be empty/);
    expect(withWindow({ start: '9am' })).toMatch(/window\.start must be a local time/);
    expect(withWindow({ start: '24:00' })).toMatch(/window\.start/);
    expect(withWindow({ end: '17:60' })).toMatch(/window\.end/);
    expect(withWindow({ timezone: 'Nowhere/Special' })).toMatch(/window\.timezone/);
    expect(withWindow({ from: 0 })).toMatch(/window\.from must be a positive/);
    expect(withWindow({ from: 2000, until: 1000 })).toMatch(/from must be before window\.until/);
    expect(withWindow({ zone: 'UTC' })).toMatch(/window has unknown key "zone"/);
  });

  it('refuses a window whose start and end are the same time, which OpenCode treats as an empty window', () => {
    const withWindow = (when) => validateModelRoute('x', { ...base, schedules: [{ when, factor: 0.5 }] });
    expect(withWindow({ start: '09:00', end: '09:00' })).toMatch(/window\.start and window\.end must not be the same time/);
    expect(withWindow({ start: '00:00', end: '00:00' })).toMatch(/empty window that can never apply/);
    expect(withWindow({ start: '9:00', end: '09:00' })).toMatch(/must not be the same time/);
    expect(withWindow({ start: '09:00:15', end: '09:00:45' })).toMatch(/must not be the same time/);
  });

  it('accepts day numbers, single-digit times and a start past its end, which OpenCode runs past midnight', () => {
    const withWindow = (when) => validateModelRoute('x', { ...base, schedules: [{ when, factor: 0.5 }] });
    expect(withWindow({ daysOfWeek: [0, 6], daysOfMonth: [-1] })).toBeNull();
    expect(withWindow({ start: '22:00', end: '06:00' })).toBeNull();
    expect(withWindow({ start: '09:00' })).toBeNull();
    expect(withWindow({ end: '17:00' })).toBeNull();
    expect(withWindow({ start: '09:00', end: '09:01' })).toBeNull();
    expect(withWindow({ timezone: 'UTC', from: 1000, until: 2000 })).toBeNull();
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
    expect(response.out.body).toEqual({ routes: { old: { targets: ['a/b'] } }, tuning: null, path: '/u/opencode.json' });
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

  it('PUT saves a pool with schedules as sent, beside a pool without one', async () => {
    const { app, routes } = makeApp();
    registerModelRouteRoutes(app, deps);
    const [, , , handler] = routes.put[0];
    const sent = {
      other: { targets: ['openai/x'] },
      peak: {
        targets: ['deepseek/v4'],
        schedules: [{ when: { daysOfWeek: ['mon'], start: '09:00', end: '17:00' }, factor: 0.5 }],
      },
    };
    const response = res();
    await handler({ body: { routes: sent } }, response);
    expect(response.out.status).toBeUndefined();
    expect(targetConfig.experimental.model_routes).toEqual(sent);
    expect(response.out.body.routes).toEqual(sent);
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
});

describe('validateModelRoute strictness', () => {
  const base = { targets: ['a/b'] };

  it('names an unknown key on the route, a target, a health block and a budget', () => {
    expect(validateModelRoute('x', { ...base, attmepts: 2 })).toMatch(/route "x" has unknown key "attmepts" \(expected name, targets/);
    expect(validateModelRoute('x', { targets: [{ model: 'a/b', defualtVariant: 'max' }] })).toMatch(/unknown key "defualtVariant"/);
    expect(validateModelRoute('x', { ...base, health: { sampleWindo: 5 } })).toMatch(/health has unknown key "sampleWindo"/);
    expect(validateModelRoute('x', { ...base, budgets: { 'a/b': { requestsPerDayy: 5 } } })).toMatch(/budget for "a\/b" has unknown key "requestsPerDayy"/);
  });

  it('refuses a budget for a target the route does not have', () => {
    expect(validateModelRoute('x', { targets: ['a/b', 'c/d'], budgets: { 'a/b': { requestsPerDay: 5 }, 'c/d': { tokensPerDay: 5 } } })).toBeNull();
    expect(validateModelRoute('x', { ...base, budgets: { 'c/d': { requestsPerDay: 5 } } })).toMatch(/budget for "c\/d" matches no target/);
    expect(validateModelRoute('x', { targets: ['a/b#high'], budgets: { 'a/b': { requestsPerDay: 5 } } })).toBeNull();
    expect(validateModelRoute('x', { targets: ['openai/gpt-*'], budgets: { 'openai/gpt-6-luna': { requestsPerDay: 5 } } })).toBeNull();
    expect(validateModelRoute('x', { targets: ['openai/gpt-*'], budgets: { 'anthropic/gpt-6-luna': { requestsPerDay: 5 } } })).toMatch(/budget for "anthropic\/gpt-6-luna" matches no target/);
  });

  it('refuses a budget keyed by a pattern, which OpenCode never reads', () => {
    expect(validateModelRoute('x', { targets: ['openai/*'], budgets: { 'openai/*': { requestsPerDay: 5 } } })).toMatch(/budget for "openai\/\*" is keyed by a pattern/);
    expect(validateModelRoute('x', { targets: ['openai/*'], budgets: { 'openai/gpt-*': { requestsPerDay: 5 } } })).toMatch(/budget for "openai\/gpt-\*" is keyed by a pattern/);
    expect(validateModelRoute('x', { targets: ['openai/*'], budgets: { 'openai/gpt-6-luna': { requestsPerDay: 5 } } })).toBeNull();
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
