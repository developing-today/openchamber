import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchQuota } from './cursor.js';

const futureToken = () => {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `header.${payload}.signature`;
};

const mockResponses = (routes) => {
  const fetchMock = vi.fn(async (url) => {
    const match = Object.entries(routes).find(([fragment]) => String(url).includes(fragment));
    if (!match) throw new Error(`Unexpected fetch: ${url}`);
    const { status = 200, body = {} } = match[1];
    return { ok: status < 400, status, json: async () => body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const ok = (body) => ({ status: 200, body });
const notFound = () => ({ status: 404 });

const enterpriseRoutes = {
  GetCurrentPeriodUsage: ok({ billingCycleStart: '1787932328088', billingCycleEnd: '1787932328088', displayThreshold: 100 }),
  GetPlanInfo: ok({ planInfo: { planName: 'Enterprise', price: 'Custom', billingCycleEnd: '1788220800000' } }),
  GetCreditGrantsBalance: ok({}),
  full_stripe_profile: ok({ teamId: 424242, isTeamMember: true, membershipType: 'enterprise' }),
  'auth/usage': ok({ 'gpt-4': { numRequests: 590, maxRequestUsage: 1000 } }),
  GetHardLimit: ok({ hardLimit: 12500, hardLimitPerUser: 250 }),
  GetTeamSpend: ok({ teamMemberSpend: [] }),
  GetMe: ok({ userId: 424242, email: 'me@example.com', teamId: 424242, isEnterpriseUser: true })
};

beforeEach(() => {
  process.env.CURSOR_TOKEN = futureToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.CURSOR_TOKEN;
  delete process.env.CURSOR_REFRESH_TOKEN;
});

const stallFetch = () => {
  const nativeTimeout = AbortSignal.timeout;
  const requestedDeadlines = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    requestedDeadlines.push(milliseconds);
    // Abort quickly so the test proves the deadline path without waiting the
    // production 15 seconds; the collected argument keeps it asserted.
    return nativeTimeout(1);
  });
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  })));
  return requestedDeadlines;
};

describe('Cursor quota', () => {
  it('does not fabricate on-demand exhaustion when spendLimitUsage omits the remaining amount', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300 },
        spendLimitUsage: { individualLimit: 2000 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.on_demand.usedPercent).toBeNull();
    expect(result.usage.windows.on_demand.valueLabel).toBe('$20.00 limit');
  });

  it.each([
    [1500, 25, '$15.00 remaining of $20.00'],
    [0, 100, '$0.00 remaining of $20.00']
  ])('reports on-demand remaining %s as %s%% used', async (individualRemaining, expectedUsedPercent, expectedLabel) => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300 },
        spendLimitUsage: { individualLimit: 2000, individualRemaining }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.on_demand.usedPercent).toBe(expectedUsedPercent);
    expect(result.usage.windows.on_demand.valueLabel).toBe(expectedLabel);
  });

  it('makes no remaining claim for plan_limit when the payload omits the remaining amount', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300, limit: 2000 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.plan_limit.usedPercent).toBeNull();
    expect(result.usage.windows.plan_limit.valueLabel).toBe('$20.00 limit');
  });

  it('reports plan_limit from a reported remaining amount', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300, limit: 2000, remaining: 500 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.plan_limit.usedPercent).toBe(75);
    expect(result.usage.windows.plan_limit.valueLabel).toBe('$5.00 remaining of $20.00');
  });

  it('keeps the planUsage path for Pro accounts', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ enabled: true, planUsage: { totalPercentUsed: 42, totalSpend: 2300 } }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerName).toBe('Cursor Pro');
    expect(result.usage.windows.billing_cycle.usedPercent).toBe(42);
    expect(result.usage.windows.billing_cycle.valueLabel).toBe('$23.00');
  });

  it.each([
    [150, 100],
    [-20, 0],
    [200, 100],
    [42, 42]
  ])('clamps billing_cycle totalPercentUsed %s to %s', async (totalPercentUsed, expectedUsedPercent) => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ enabled: true, planUsage: { totalPercentUsed, totalSpend: 2300 } }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.usedPercent).toBe(expectedUsedPercent);
  });

  it.each([
    [150, 100],
    [-20, 0],
    [200, 100],
    [42, 42]
  ])('clamps autoPercentUsed %s to %s', async (autoPercentUsed, expectedUsedPercent) => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, autoPercentUsed, apiPercentUsed: 10, totalSpend: 2300 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.auto.usedPercent).toBe(expectedUsedPercent);
    expect(result.usage.windows.auto.remainingPercent).toBe(100 - expectedUsedPercent);
  });

  it.each([
    [150, 100],
    [-20, 0],
    [200, 100],
    [42, 42]
  ])('clamps apiPercentUsed %s to %s', async (apiPercentUsed, expectedUsedPercent) => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, autoPercentUsed: 10, apiPercentUsed, totalSpend: 2300 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.api.usedPercent).toBe(expectedUsedPercent);
    expect(result.usage.windows.api.remainingPercent).toBe(100 - expectedUsedPercent);
  });

  it('omits the auto and api windows when their percentages are missing', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ enabled: true, planUsage: { totalPercentUsed: 42, totalSpend: 2300 } }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.usedPercent).toBe(42);
    expect(result.usage.windows.auto).toBeUndefined();
    expect(result.usage.windows.api).toBeUndefined();
  });

  it('reports windowSeconds as the billing-cycle duration, not time until reset', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        billingCycleStart: '1700000000000',
        billingCycleEnd: '1702592000000',
        planUsage: { totalPercentUsed: 42, totalSpend: 2300 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBe(2592000);
  });

  it('reports windowSeconds as null when the billing-cycle start is missing', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        billingCycleEnd: 1702592000000,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBeNull();
    expect(result.usage.windows.billing_cycle.resetAt).toBe(1702592000000);
  });

  it('reports windowSeconds as null when the billing-cycle start is not before the end', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        billingCycleStart: 1702592000000,
        billingCycleEnd: 1702592000000,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBeNull();
  });

  it('falls back to auth/usage and team-scoped GetHardLimit for enterprise accounts', async () => {
    const fetchMock = mockResponses(enterpriseRoutes);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerName).toBe('Cursor Enterprise');
    expect(result.usage.windows.billing_cycle.valueLabel).toBe('590 / 1000');
    expect(result.usage.windows.billing_cycle.usedPercent).toBe(59);
    expect(result.usage.windows.on_demand).toBeUndefined();
    const hardLimitCall = fetchMock.mock.calls.find(([url]) => String(url).includes('GetHardLimit'));
    expect(JSON.parse(hardLimitCall[1].body)).toEqual({ teamId: '424242' });
  });

  it('reports enterprise windowSeconds as the billing-cycle duration', async () => {
    mockResponses(enterpriseRoutes);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBe(288471);
  });

  it('reports enterprise windowSeconds when billingCycleStart is only in planInfo', async () => {
    mockResponses({
      ...enterpriseRoutes,
      GetCurrentPeriodUsage: ok({ billingCycleEnd: '1787932328088', displayThreshold: 100 }),
      GetPlanInfo: ok({ planInfo: { planName: 'Enterprise', price: 'Custom', billingCycleStart: '1787932328088', billingCycleEnd: '1788220800000' } })
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBe(288471);
  });

  it('reports enterprise windowSeconds as null when the billing-cycle start is missing', async () => {
    mockResponses({
      ...enterpriseRoutes,
      GetCurrentPeriodUsage: ok({ billingCycleEnd: '1787932328088', displayThreshold: 100 })
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBeNull();
  });

  it('reports enterprise windowSeconds as null when the billing-cycle start is not before the end', async () => {
    mockResponses({
      ...enterpriseRoutes,
      GetCurrentPeriodUsage: ok({ billingCycleStart: '1788220800000', billingCycleEnd: '1787932328088', displayThreshold: 100 })
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBeNull();
  });

  it('picks the largest request bucket and skips metadata', async () => {
    mockResponses({
      ...enterpriseRoutes,
      'auth/usage': ok({
        startOfMonth: '2026-08-01',
        'gpt-4o': { numRequests: 120, maxRequestUsage: 500 },
        'gpt-4': { numRequests: 829, maxRequestUsage: 1000 }
      })
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.valueLabel).toBe('829 / 1000');
  });

  it('reports on-demand spend from GetTeamSpend for enterprise accounts', async () => {
    mockResponses({
      ...enterpriseRoutes,
      GetTeamSpend: ok({
        teamMemberSpend: [
          { userId: 999999, spendCents: 100 },
          { userId: 424242, spendCents: 672 }
        ]
      })
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.on_demand.valueLabel).toBe('$6.72 / $250.00');
    expect(result.usage.windows.on_demand.usedPercent).toBeCloseTo(2.688, 3);
  });

  it('does not report success from plan name alone', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ billingCycleStart: '1787932328088' }),
      GetPlanInfo: ok({ planInfo: { planName: 'Enterprise', billingCycleEnd: '1788220800000' } }),
      GetCreditGrantsBalance: notFound(),
      full_stripe_profile: ok({ teamId: 424242, isTeamMember: true }),
      'auth/usage': notFound(),
      GetHardLimit: notFound(),
      GetTeamSpend: notFound(),
      GetMe: notFound()
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No active Cursor subscription');
  });

  it('omits the on-demand window when spend cannot be verified', async () => {
    mockResponses({
      ...enterpriseRoutes,
      GetTeamSpend: notFound()
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.valueLabel).toBe('590 / 1000');
    expect(result.usage.windows.on_demand).toBeUndefined();
  });

  it('reports a disabled subscription as an error', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ enabled: false }),
      GetPlanInfo: notFound(),
      GetCreditGrantsBalance: notFound()
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No active Cursor subscription');
  });

  it('still errors when an enterprise fallback finds no usable data', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ billingCycleStart: '1787932328088' }),
      GetPlanInfo: notFound(),
      GetCreditGrantsBalance: notFound(),
      full_stripe_profile: notFound(),
      'auth/usage': notFound(),
      GetHardLimit: notFound()
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No active Cursor subscription');
  });

  it('times out a stalled usage call instead of hanging', async () => {
    const requestedDeadlines = stallFetch();

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('Request timed out');
    expect(requestedDeadlines[0]).toBe(15_000);
  });

  it('times out a stalled token refresh instead of hanging', async () => {
    delete process.env.CURSOR_TOKEN;
    process.env.CURSOR_REFRESH_TOKEN = 'refresh-token';
    const requestedDeadlines = stallFetch();

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Request timed out');
    expect(requestedDeadlines).toEqual([15_000]);
  });
});
