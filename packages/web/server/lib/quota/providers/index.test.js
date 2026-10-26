import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ projected: {}, rows: [] }));
const configState = vi.hoisted(() => ({ merged: {} }));

vi.mock('../../opencode/auth.js', () => ({
  readOpenCodeCredentials: async () => authState.projected,
  listStoredCredentials: async (integrationID) => (integrationID
    ? authState.rows.filter((row) => row.integrationID === integrationID)
    : authState.rows),
}));

vi.mock('../../opencode/shared.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readConfigLayers: () => ({ mergedConfig: configState.merged, layerErrors: [] }),
  };
});

import * as google from './google/index.js';
import { fetchQuotaForProvider, fetchQuotaForProviderInstances, listConfiguredQuotaProviders, listQuotaProviderCatalogue } from './index.js';

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
  return { ok: true, status: 200, json: async () => ({ data: {} }) };
};

const oauthRow = (integrationID, { id, label, active, access, accountId }) => ({
  id,
  integrationID,
  label,
  active,
  value: { type: 'oauth', access, refresh: 'rt', expires: 1, ...(accountId ? { accountId } : {}) },
});

const legacyRow = oauthRow('openai', { id: 'cred_legacy', label: 'OAuth', active: false, access: 'legacy-token', accountId: 'acc_main' });
const sharingRow = oauthRow('openai', { id: 'cred_sharing', label: 'OpenAI 2', active: true, access: 'sharing-token' });

beforeEach(() => {
  authState.projected = {};
  authState.rows = [];
  configState.merged = {};
  vi.stubGlobal('fetch', fakeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
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
});

describe('disabled providers', () => {
  beforeEach(() => {
    authState.projected = {
      openrouter: { type: 'api', key: 'or-key' },
      'github-copilot': { type: 'oauth', access: 'gh-token' },
      openai: { type: 'oauth', access: 'sharing-token' },
    };
    configState.merged = { disabled_providers: ['openrouter', 'github-copilot'] };
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

describe('provider instances', () => {
  beforeEach(() => {
    configState.merged = {
      provider: {
        'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
      },
    };
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
    configState.merged = {
      disabled_providers: ['openai.alternate'],
      provider: {
        'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
      },
    };
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
    configState.merged = { disabled_providers: ['openrouter', 'github-copilot'] };
    const catalogue = listQuotaProviderCatalogue();
    expect(catalogue.find((entry) => entry.id === 'openrouter')?.disabled).toBe(true);
    expect(catalogue.find((entry) => entry.id === 'github-copilot-addon')?.disabled).toBe(true);
    expect(catalogue.find((entry) => entry.id === 'codex')?.disabled).toBe(false);
  });

  it('includes configured provider instances under their own id and name', () => {
    configState.merged = {
      provider: {
        'openai.alternate': { instanceOf: 'openai', name: 'OpenAI Alternate (Student - popesdrew)' },
      },
    };
    const catalogue = listQuotaProviderCatalogue();
    const instance = catalogue.find((entry) => entry.id === 'openai.alternate');
    expect(instance?.name).toBe('OpenAI Alternate (Student - popesdrew)');
    expect(instance?.instanceOf).toBe('codex');
    expect(instance?.disabled).toBe(false);
  });
});
