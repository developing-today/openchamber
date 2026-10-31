import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const authState = vi.hoisted(() => ({ projected: {}, rows: [] }));

vi.mock('../../opencode/auth.js', () => ({
  readOpenCodeCredentials: async () => authState.projected,
  listStoredCredentials: async (integrationID) => (integrationID
    ? authState.rows.filter((row) => row.integrationID === integrationID)
    : authState.rows),
}));

// The registry reads disabled_providers and provider instances through the
// real config-layer reader. Point its global config directory at a path that
// does not exist so the machine's own opencode.json can never leak into these
// assertions; the custom layer is resolved from OPENCODE_CONFIG at call time,
// so each test writes the config it needs to a fresh file.
vi.hoisted(() => {
  process.env.OPENCODE_CONFIG_DIR = 'quota-providers-test-without-config-dir';
});

import * as google from './google/index.js';
import { fetchQuotaForProvider, fetchQuotaForProviderInstances, listConfiguredQuotaProviders, listQuotaProviderCatalogue } from './index.js';

const createdConfigPaths = [];

const setMergedConfig = (config) => {
  const filePath = path.join(os.tmpdir(), `quota-providers-config-${process.pid}-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(filePath, JSON.stringify(config));
  vi.stubEnv('OPENCODE_CONFIG', filePath);
  createdConfigPaths.push(filePath);
};

const whamPayload = (email, usedPercent) => ({
  email,
  account_id: 'acc',
  plan_type: 'prolite',
  rate_limit: {
    primary_window: { used_percent: usedPercent, limit_window_seconds: 604800, reset_at: 1793513510 },
    secondary_window: null,
  },
  credits: { balance: '0', unlimited: false },
});

const fakeFetch = async (url, init = {}) => {
  const authorization = init.headers?.Authorization ?? '';
  if (String(url).includes('chatgpt.com')) {
    if (authorization === 'Bearer legacy-token') {
      return { ok: true, status: 200, json: async () => whamPayload('drewrypope@gmail.com', 8) };
    }
    if (authorization === 'Bearer alt-token') {
      return { ok: true, status: 200, json: async () => whamPayload('popesdrew@gmail.com', 12) };
    }
    return { ok: false, status: 401, json: async () => ({ error: { type: 'rejected_by_access_enforcement' } }) };
  }
  if (String(url).includes('opencode.ai/console/api/billing/status')) {
    return { ok: true, status: 200, json: async () => ({}) };
  }
  if (String(url).includes('opencode.ai/console/api/go/status')) {
    const orgID = init.headers?.['x-org-id'] ?? '';
    if (orgID === 'org_BROKEN12') {
      return { ok: true, status: 200, json: async () => ({ product: 'free', access: { meters: {} } }) };
    }
    const usedMicroCents = orgID === 'org_SECOND123' ? '900' : '250';
    return {
      ok: true,
      status: 200,
      json: async () => ({
        product: 'go',
        access: { meters: { fiveHour: { resetsAt: '2026-08-12T12:00:00.000Z', limitMicroCents: '1000', usedMicroCents } } },
      }),
    };
  }
  if (String(url).includes('opencode.ai/zen/go/v1/usage')) {
    return { ok: true, status: 200, json: async () => ({ usage: { rolling: { percent: 42, resetsAt: '2026-08-12T12:00:00.000Z' } } }) };
  }
  return { ok: true, status: 200, json: async () => ({ data: {} }) };
};

const oauthRow = (integrationID, { id, label, active, access, accountId }) => {
  const value = { type: 'oauth', access, refresh: 'rt', expires: 1 };
  if (accountId) value.accountId = accountId;
  return { id, integrationID, label, active, value };
};

const legacyRow = oauthRow('openai', { id: 'cred_legacy', label: 'OAuth', active: false, access: 'legacy-token', accountId: 'acc_main' });
const sharingRow = oauthRow('openai', { id: 'cred_sharing', label: 'OpenAI 2', active: true, access: 'sharing-token' });

beforeEach(() => {
  authState.projected = {};
  authState.rows = [];
  setMergedConfig({});
  vi.stubGlobal('fetch', fakeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const filePath of createdConfigPaths.splice(0)) {
    fs.rmSync(filePath, { force: true });
  }
});

describe('quota provider registry', () => {
  it('exposes google provider configuration helpers through the provider module', () => {
    expect(google.providerId).toBe('google');
    expect(google.providerName).toBe('Google');
    expect(typeof google.isConfigured).toBe('function');
    expect(typeof google.resolveGoogleAuthSources).toBe('function');
  });

  it('can list configured providers without missing provider exports', async () => {
    await expect(listConfiguredQuotaProviders()).resolves.toBeInstanceOf(Array);
  });

  it('coalesces concurrent refreshes by provider ID', async () => {
    const first = fetchQuotaForProvider('unsupported-test-provider');
    const second = fetchQuotaForProvider('unsupported-test-provider');

    expect(first).toBe(second);
    await first;
    expect(fetchQuotaForProvider('unsupported-test-provider')).not.toBe(first);
  });

  it('releases the coalescing entry once a timed-out provider settles', async () => {
    authState.projected = { 'github-copilot': { type: 'oauth', access: 'gh-token' } };
    const nativeTimeout = AbortSignal.timeout;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => nativeTimeout(1));
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    })));

    const timedOut = await fetchQuotaForProvider('github-copilot');
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toBe('Request timed out');

    // The deadline settles the promise, so its .finally releases the entry and
    // the next request fetches again instead of reusing the dead promise.
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 80 } },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const fresh = await fetchQuotaForProvider('github-copilot');
    expect(fresh.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('disabled providers', () => {
  beforeEach(() => {
    authState.projected = {
      openrouter: { type: 'api', key: 'or-key' },
      'github-copilot': { type: 'oauth', access: 'gh-token' },
      openai: { type: 'oauth', access: 'sharing-token' },
    };
    setMergedConfig({ disabled_providers: ['openrouter', 'github-copilot'] });
  });

  it('leaves disabled providers out of the listing by default', async () => {
    const configured = await listConfiguredQuotaProviders();
    expect(configured).toContain('codex');
    expect(configured).not.toContain('openrouter');
    expect(configured).not.toContain('github-copilot');
    // The add-on row reads the same Copilot credential, so it goes too.
    expect(configured).not.toContain('github-copilot-addon');
  });

  it('includes disabled providers when asked', async () => {
    const configured = await listConfiguredQuotaProviders({ includeDisabled: true });
    expect(configured).toContain('openrouter');
    expect(configured).toContain('github-copilot');
    expect(configured).toContain('github-copilot-addon');
  });

  it('still fetches a disabled provider named explicitly', async () => {
    const result = await fetchQuotaForProvider('openrouter');
    expect(result.providerId).toBe('openrouter');
    expect(result.error).not.toBe('Unsupported provider');

    const [instanceResult] = await fetchQuotaForProviderInstances('openrouter');
    expect(instanceResult.providerId).toBe('openrouter');
  });
});

describe('meta provider listing', () => {
  it('lists meta once the meta credential is present', async () => {
    authState.projected = { meta: { type: 'api', key: 'LLM|test-minted-key' } };
    await expect(listConfiguredQuotaProviders()).resolves.toContain('meta');
  });

  it('leaves meta out without a credential', async () => {
    authState.projected = {};
    await expect(listConfiguredQuotaProviders()).resolves.not.toContain('meta');
  });

  it('catalogues meta under its id with the meta alias', () => {
    const meta = listQuotaProviderCatalogue().find((entry) => entry.id === 'meta');
    expect(meta?.name).toBe('Meta Model API');
    expect(meta?.aliases).toContain('meta');
    expect(meta?.disabled).toBe(false);
  });
});

describe('per-credential quota', () => {
  beforeEach(() => {
    authState.projected = { openai: sharingRow.value };
    authState.rows = [legacyRow, sharingRow];
  });

  it('returns one labeled result per stored Codex credential', async () => {
    const results = await fetchQuotaForProviderInstances('codex');
    expect(results).toHaveLength(2);

    const [legacy, sharing] = results;
    expect(legacy.ok).toBe(true);
    expect(legacy.credentialId).toBe('cred_legacy');
    expect(legacy.credentialLabel).toBe('OAuth');
    expect(legacy.credentialActive).toBe(false);
    expect(legacy.accountLabel).toBe('drewrypope@gmail.com');
    expect(legacy.usage.windows.weekly.usedPercent).toBe(8);

    expect(sharing.ok).toBe(false);
    expect(sharing.credentialId).toBe('cred_sharing');
    expect(sharing.credentialLabel).toBe('OpenAI 2');
    expect(sharing.credentialActive).toBe(true);
    expect(sharing.error).toContain('chatgpt.com/settings/usage');
  });

  it('keeps the single-result shape when the store holds one credential', async () => {
    authState.rows = [legacyRow];
    const results = await fetchQuotaForProviderInstances('codex');
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].credentialLabel).toBe('OAuth');
  });

  it('falls back to the active-credential fetch when the store holds no rows', async () => {
    authState.rows = [];
    authState.projected = { openai: legacyRow.value };
    const results = await fetchQuotaForProviderInstances('codex');
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].credentialId).toBeUndefined();
  });
});

describe('per-credential quota — OpenCode Go workspaces', () => {
  const consoleRow = (id, label, active, orgID) => ({
    id,
    integrationID: 'opencode',
    label,
    active,
    value: {
      type: 'oauth',
      access: `token-${orgID}`,
      refresh: 'rt',
      expires: Date.now() + 3_600_000,
      server: 'https://opencode.ai/console',
      orgID,
    },
  });

  // The gate from #768: two stored Console rows with distinct orgIDs
  // must enumerate as two distinct usable per-workspace rows.
  it('returns one labeled row per stored Console workspace and skips unusable rows', async () => {
    authState.rows = [
      consoleRow('cred_ws1', 'Workspace One', true, 'org_FIRST123'),
      consoleRow('cred_ws2', undefined, false, 'org_SECOND123'),
      // Not a Console sign-in (another server): unusable for Go, skipped.
      { id: 'cred_other', integrationID: 'opencode', label: 'Other', active: false, value: { type: 'oauth', access: 'x', refresh: 'rt', expires: 1, server: 'https://example.com/console', orgID: 'org_OTHER123' } },
    ];
    const results = await fetchQuotaForProviderInstances('opencode-go');
    expect(results).toHaveLength(2);

    const [first, second] = results;
    expect(first.credentialId).toBe('cred_ws1');
    expect(first.credentialLabel).toBe('Workspace One');
    expect(first.credentialActive).toBe(true);
    expect(first.accountLabel).toBe('org_FIRST123');
    expect(first.planLabel).toBe('go');
    expect(first.usage.windows['5h'].usedPercent).toBe(25);

    expect(second.credentialId).toBe('cred_ws2');
    expect(second.credentialLabel).toBeUndefined();
    expect(second.accountLabel).toBe('org_SECOND123');
    expect(second.usage.windows['5h'].usedPercent).toBe(90);
  });

  it('isolates a failing workspace row from the healthy ones', async () => {
    authState.rows = [
      consoleRow('cred_ok', 'OK', true, 'org_FIRST123'),
      consoleRow('cred_broken', 'Broken', false, 'org_BROKEN12'),
    ];
    const results = await fetchQuotaForProviderInstances('opencode-go');
    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].credentialId).toBe('cred_broken');
    expect(results[1].error).toMatch(/subscription/i);
  });

  it('falls back to the single combined row when the store holds no usable rows', async () => {
    authState.rows = [];
    authState.projected = { opencode: consoleRow('cred_active', 'Active', true, 'org_FIRST123').value };
    const results = await fetchQuotaForProviderInstances('opencode-go');
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].credentialId).toBeUndefined();
    expect(results[0].usage.windows['5h'].usedPercent).toBe(25);
  });

  it('puts the Console row before the API-key row when both credential types are stored', async () => {
    authState.rows = [
      { id: 'cred_key', integrationID: 'opencode-go', label: 'API Key', active: true, value: { type: 'api', key: 'go-key' } },
      consoleRow('cred_ws1', 'Workspace One', true, 'org_FIRST123'),
    ];
    const results = await fetchQuotaForProviderInstances('opencode-go');
    expect(results).toHaveLength(2);

    const [primary, keyRow] = results;
    expect(primary.credentialId).toBe('cred_ws1');
    expect(primary.credentialActive).toBe(true);
    expect(primary.accountLabel).toBe('org_FIRST123');
    expect(primary.ok).toBe(true);

    expect(keyRow.credentialId).toBe('cred_key');
    expect(keyRow.credentialLabel).toBe('API Key');
    expect(keyRow.credentialActive).toBe(true);
    expect(keyRow.ok).toBe(true);
    expect(keyRow.usage.windows['5h'].usedPercent).toBe(42);
  });

  it('catalogues opencode-go with the shared opencode credential alias', () => {
    const entry = listQuotaProviderCatalogue().find((candidate) => candidate.id === 'opencode-go');
    expect(entry?.aliases).toEqual(expect.arrayContaining(['opencode-go', 'opencode']));
  });
});

describe('provider instances', () => {
  beforeEach(() => {
    setMergedConfig({
      provider: {
        'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
      },
    });
    authState.rows = [
      oauthRow('openai.alternate', { id: 'cred_alt', label: 'OAuth', active: true, access: 'alt-token', accountId: 'acc_alt' }),
    ];
  });

  it('lists an instance that has a usable credential', async () => {
    await expect(listConfiguredQuotaProviders()).resolves.toContain('openai.alternate');
  });

  it('fetches an instance as its own labeled row', async () => {
    const results = await fetchQuotaForProviderInstances('openai.alternate');
    expect(results).toHaveLength(1);
    expect(results[0].providerId).toBe('openai.alternate');
    expect(results[0].providerName).toBe('OpenAI Alternate (Student - popesdrew)');
    expect(results[0].accountLabel).toBe('popesdrew@gmail.com');
    expect(results[0].usage.windows.weekly.usedPercent).toBe(12);

    const single = await fetchQuotaForProvider('openai.alternate');
    expect(single.providerId).toBe('openai.alternate');
    expect(single.ok).toBe(true);
  });

  it('leaves a disabled instance out of the listing', async () => {
    setMergedConfig({
      disabled_providers: ['openai.alternate'],
      provider: {
        'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
      },
    });
    await expect(listConfiguredQuotaProviders()).resolves.not.toContain('openai.alternate');
    await expect(listConfiguredQuotaProviders({ includeDisabled: true })).resolves.toContain('openai.alternate');
  });

  it('does not list an instance with no credential', async () => {
    authState.rows = [];
    await expect(listConfiguredQuotaProviders()).resolves.not.toContain('openai.alternate');
  });
});

describe('provider catalogue', () => {
  it('lists every provider with its display name and credential aliases', () => {
    const catalogue = listQuotaProviderCatalogue();
    const codex = catalogue.find((entry) => entry.id === 'codex');
    expect(codex?.name).toBe('Codex');
    expect(codex?.aliases).toEqual(expect.arrayContaining(['openai', 'chatgpt']));
    expect(codex?.disabled).toBe(false);
    const copilot = catalogue.find((entry) => entry.id === 'github-copilot');
    expect(copilot?.name).toBe('GitHub Copilot');
    expect(copilot?.aliases).toContain('copilot');
  });

  it('marks providers the merged config turns off as disabled', () => {
    setMergedConfig({ disabled_providers: ['openrouter', 'github-copilot'] });
    const catalogue = listQuotaProviderCatalogue();
    expect(catalogue.find((entry) => entry.id === 'openrouter')?.disabled).toBe(true);
    expect(catalogue.find((entry) => entry.id === 'github-copilot-addon')?.disabled).toBe(true);
    expect(catalogue.find((entry) => entry.id === 'codex')?.disabled).toBe(false);
  });

  it('includes configured provider instances under their own id and name', () => {
    setMergedConfig({
      provider: {
        'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
      },
    });
    const catalogue = listQuotaProviderCatalogue();
    const instance = catalogue.find((entry) => entry.id === 'openai.alternate');
    expect(instance?.name).toBe('OpenAI Alternate (Student - popesdrew)');
    expect(instance?.instanceOf).toBe('codex');
    expect(instance?.disabled).toBe(false);
  });
});

// The registry is a plain object, so an unguarded lookup resolves these names
// to Object.prototype members: `constructor` reached the fetch path and
// fabricated a configured result, and `__proto__` resolved to an object with
// no fetcher.
const prototypeNames = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];

describe('provider registry lookup uses own properties', () => {
  it('dispatches a prototype name exactly like an unknown provider id', async () => {
    const unknown = await fetchQuotaForProvider('not-a-provider');
    expect(unknown).toMatchObject({ providerId: 'not-a-provider', ok: false, configured: false, error: 'Unsupported provider' });

    for (const providerName of prototypeNames) {
      const fetched = await fetchQuotaForProvider(providerName);
      expect(fetched).toMatchObject({ providerId: providerName, ok: false, configured: false, error: 'Unsupported provider' });

      const instances = await fetchQuotaForProviderInstances(providerName);
      expect(instances).toEqual([
        expect.objectContaining({ providerId: providerName, ok: false, configured: false, error: 'Unsupported provider' }),
      ]);
    }
  });

  it('never reports a prototype name as configured', async () => {
    authState.projected = { 'github-copilot': { type: 'oauth', access: 'gh-token' } };

    const configured = await listConfiguredQuotaProviders();

    expect(configured).toContain('github-copilot');
    for (const providerName of prototypeNames) {
      expect(configured).not.toContain(providerName);
    }
  });

  it('still dispatches a real provider id through its registry row', async () => {
    authState.projected = { 'github-copilot': { type: 'oauth', access: 'gh-token' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 80 } },
    })));

    const fetched = await fetchQuotaForProvider('github-copilot');

    expect(fetched).toMatchObject({ providerId: 'github-copilot', ok: true, configured: true });
  });
});
