import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// No antigravity-accounts.json in the scratch config dir: every sign-in
// below lives only in OpenCode's credential store, which is the shape
// current opencode-antigravity-auth versions produce. The accounts file
// path is resolved when the module loads, so point it at the scratch
// directory before importing the providers.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-antigravity-store-'));
process.env.OPENCODE_CONFIG_DIR = configDir;

const { fetchQuotaForProvider, listConfiguredQuotaProviders } = await import('./quotaProviders');
const { configureOpenCodeCredentials } = await import('./opencodeAuth');

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  configureOpenCodeCredentials(null);
});

after(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

const configureStoreOAuth = (refresh: string) => {
  configureOpenCodeCredentials({
    list: async () => [{
      id: 'test-google',
      integrationID: 'google',
      label: 'default',
      active: true,
      value: { type: 'oauth', methodID: 'oauth', metadata: {}, access: 'old-access', refresh, expires: 1 },
    }],
  });
};

const configureStoreApiKey = (key: string) => {
  configureOpenCodeCredentials({
    list: async () => [{
      id: 'test-google',
      integrationID: 'google',
      label: 'default',
      active: true,
      value: { type: 'key', key },
    }],
  });
};

describe('VS Code Antigravity quota from the credential store', () => {
  it('reads a store-only OAuth sign-in as configured and fetches its quota', async () => {
    configureStoreOAuth('store-refresh|store-project|managed-project');

    const configured = await listConfiguredQuotaProviders();
    assert.ok(configured.includes('antigravity'));

    const refreshTokens: Array<string | null> = [];
    globalThis.fetch = async (url, options) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        assert.ok(options?.body instanceof URLSearchParams);
        refreshTokens.push(options.body.get('refresh_token'));
        return Response.json({ access_token: 'store-access' });
      }
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer store-access');
      if (String(url).endsWith(':retrieveUserQuotaSummary')) {
        return Response.json({ groups: [] });
      }
      return Response.json({
        models: {
          'gemini-store': { quotaInfo: { remainingFraction: 0.9, resetTime: '2026-10-25T10:00:00Z' } },
        },
      });
    };

    const result = await fetchQuotaForProvider('antigravity');

    assert.equal(result.ok, true);
    assert.equal(result.configured, true);
    assert.deepEqual(refreshTokens, ['store-refresh']);
    assert.equal(result.usage?.models?.['gemini-store']?.windows['5h']?.remainingPercent, 90);
    assert.ok(!JSON.stringify(result).includes('store-refresh'));
    assert.ok(!JSON.stringify(result).includes('store-access'));
  });

  it('reports a credential-store read failure as a refresh error, not as Not configured', async () => {
    configureOpenCodeCredentials({
      list: async () => {
        throw new Error('credential store unavailable');
      },
    });

    const result = await fetchQuotaForProvider('antigravity');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'Failed to read OpenCode credentials');
  });

  it('does not treat a google API-key entry as an Antigravity login', async () => {
    configureStoreApiKey('api-key-value');

    const configured = await listConfiguredQuotaProviders();
    assert.ok(!configured.includes('antigravity'));

    globalThis.fetch = async () => {
      throw new Error('no network call expected without a login');
    };

    const result = await fetchQuotaForProvider('antigravity');

    assert.equal(result.ok, false);
    assert.equal(result.configured, false);
    assert.equal(result.error, 'Not configured');
  });
});
