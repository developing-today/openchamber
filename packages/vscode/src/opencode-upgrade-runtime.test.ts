import { afterEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { getOpenCodeUpgradeStatus, upgradeManagedOpenCode, type OpenCodeUpgradeManager } from './opencode-upgrade-runtime';

const originalFetch = globalThis.fetch;
const originalLowerRegistry = process.env.npm_config_registry;
const originalRegistry = process.env.NPM_CONFIG_REGISTRY;
const originalUserConfig = process.env.npm_config_userconfig;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLowerRegistry === undefined) delete process.env.npm_config_registry;
  else process.env.npm_config_registry = originalLowerRegistry;
  if (originalRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY;
  else process.env.NPM_CONFIG_REGISTRY = originalRegistry;
  if (originalUserConfig === undefined) delete process.env.npm_config_userconfig;
  else process.env.npm_config_userconfig = originalUserConfig;
});

const createManager = (mode: 'managed' | 'external' = 'managed'): OpenCodeUpgradeManager => ({
  getApiUrl: () => 'http://127.0.0.1:4096',
  getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
  getDebugInfo: () => ({ mode, cliPath: '/test/opencode' }),
  upgradeCli: async () => {},
});

describe('VS Code OpenCode upgrades', () => {
  test('uses the configured registry and Basic headers for the v2 package version', async () => {
    process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
    process.env.npm_config_registry = 'https://user:p%40ss@mirror.example.com/npm/';
    const fetch = mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      return Response.json({ version: url.endsWith('/api/info') ? '2.0.21' : '2.0.22' });
    });
    try {
      const status = await getOpenCodeUpgradeStatus(createManager());
      assert.equal(status.latestVersion, '2.0.22');
      const call = fetch.mock.calls.find((entry) => String(entry.arguments[0]).includes('mirror.example.com'));
      assert.equal(String(call?.arguments[0]), 'https://mirror.example.com/npm/@opencode%2Fcli/latest');
      assert.equal(new Headers(call?.arguments[1]?.headers).get('Authorization'), `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
    } finally {
      fetch.mock.restore();
    }
  });

  test('reports invalid registry configuration without a public-registry fallback', async () => {
    process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
    process.env.npm_config_registry = 'not-a-url';
    const fetch = mock.method(globalThis, 'fetch', async () => Response.json({ version: '2.0.21' }));
    try {
      const status = await getOpenCodeUpgradeStatus(createManager());
      assert.equal(status.available, null);
      assert.equal(status.error, 'Invalid npm registry URL');
      assert.equal(fetch.mock.calls.some((entry) => String(entry.arguments[0]).includes('registry.npmjs.org')), false);
    } finally {
      fetch.mock.restore();
    }
  });

  test('reports installed and latest versions from the v2 info route', async () => {
    const manager = createManager();
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/info')) return new Response(JSON.stringify({ version: '2.0.1', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
      if (url.includes('registry.npmjs.org')) return new Response(JSON.stringify({ version: '2.0.2' }));
      return new Response(JSON.stringify({ tag_name: 'v2.0.2' }));
    }) as typeof fetch;

    assert.deepEqual(await getOpenCodeUpgradeStatus(manager), {
      available: true,
      currentVersion: '2.0.1',
      latestVersion: '2.0.2',
      upgrade: { supported: true, manager: 'opencode', reason: null },
    });
  });

  test('never claims an upgrade for a malformed version on either side', async () => {
    const manager = createManager();
    const statusFor = async (currentVersion: string, latestVersion: string) => {
      // SAFETY: the stub answers only the two routes getOpenCodeUpgradeStatus
      // fetches, with the same Response shapes the real endpoints return.
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith('/api/info')) return new Response(JSON.stringify({ version: currentVersion, pid: 1, urls: [], paths: { tmp: '/tmp' } }));
        return new Response(JSON.stringify({ version: latestVersion }));
      }) as typeof fetch;
      return getOpenCodeUpgradeStatus(manager);
    };

    // Trailing junk: parseInt('1junk') is 1, so this read as 2.1 > 2.0.9.
    assert.equal((await statusFor('2.0.9', '2.1junk')).available, false);
    // Empty part: parseInt('') fell back to 0, so the installed '2..1' read as 2.0.1 < 2.0.2.
    assert.equal((await statusFor('2..1', '2.0.2')).available, false);
    // Non-numeric part: read as 0, so '2.0.x' silently equalled a real 2.0.0.
    assert.equal((await statusFor('2.0.0', '2.0.x')).available, false);
    // Parseable versions still compare normally, prerelease included.
    assert.equal((await statusFor('2.0.1', '2.0.2')).available, true);
    assert.equal((await statusFor('2.0.2', '2.0.2-beta.1')).available, false);
  });

  test('still reports the running version for an externally managed OpenCode', async () => {
    const manager = createManager('external');
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/info')) return new Response(JSON.stringify({ version: '2.0.2', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
      return new Response(JSON.stringify({ version: '2.0.2' }));
    }) as typeof fetch;

    const status = await getOpenCodeUpgradeStatus(manager);
    assert.equal(status.currentVersion, '2.0.2');
    assert.deepEqual(status.upgrade, { supported: false, manager: 'external', reason: 'external' });
  });

  test('rejects external upgrades without contacting OpenCode', async () => {
    const manager = createManager('external');
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response('{}');
    }) as typeof fetch;

    const result = await upgradeManagedOpenCode(manager);
    assert.equal(result.status, 409);
    if (result.status !== 409) assert.fail('Expected unsupported response');
    assert.equal(result.body.code, 'OPENCODE_UPGRADE_UNSUPPORTED');
    assert.equal(fetchCount, 0);
  });
  test('shares concurrent upgrades and permits a new attempt after failure', async () => {
    const manager = createManager();
    let calls = 0;
    let rejectUpgrade: (error: Error) => void = () => { throw new Error('Upgrade not started'); };
    manager.upgradeCli = () => {
      calls += 1;
      return new Promise<void>((_resolve, reject) => { rejectUpgrade = reject; });
    };
    const first = upgradeManagedOpenCode(manager);
    const second = upgradeManagedOpenCode(manager);
    assert.equal(calls, 1);
    rejectUpgrade(new Error('Installation failed'));
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.status), [500, 500]);
    manager.upgradeCli = async () => { calls += 1; };
    assert.deepEqual(await upgradeManagedOpenCode(manager), { status: 200, body: { success: true } });
    assert.equal(calls, 2);
  });

  test('rejects a missing CLI or manager before executing anything', async () => {
    const manager = createManager();
    manager.getDebugInfo = () => ({ mode: 'managed', cliPath: null });
    manager.upgradeCli = async () => { assert.fail('Must not run'); };
    assert.equal((await upgradeManagedOpenCode(manager)).status, 409);
    assert.equal((await upgradeManagedOpenCode()).status, 409);
  });

  test('returns unavailable/error when local probe stalls', async () => {
    const manager = createManager();
    const fetch = mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0], options?: RequestInit) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org') || url.includes('/@opencode/cli/latest')) {
        return Response.json({ version: '2.0.22' });
      }
      if (url.endsWith('/api/info')) {
        // Simulate stall that hits the AbortSignal. Node's AbortSignal timeout
        // triggers on its own timer. If we just listen, the test suite waits.
        // We'll throw immediately simulating an abort if signal is provided,
        // or wait a short time. Actually, if signal is present, we can just throw
        // an Error immediately to mock AbortSignal behavior in a sync-friendly way.
        if (options?.signal) {
          throw new Error('The operation was aborted due to timeout');
        }
        return new Promise<Response>(() => {});
      }
      return Response.json({});
    });
    try {
      const status = await getOpenCodeUpgradeStatus(manager);
      assert.equal(status.available, null);
      assert.equal(status.error, 'The operation was aborted due to timeout');
      assert.deepEqual(status.upgrade, { supported: true, manager: 'opencode', reason: null });
    } finally {
      fetch.mock.restore();
    }
  });

});
