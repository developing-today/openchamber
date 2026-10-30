import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearNpmInfoCacheForTests, queryPluginRegistry } from './opencodeConfig';

const originalRegistry = process.env.npm_config_registry;
const originalUserConfig = process.env.npm_config_userconfig;

afterEach(() => {
  if (originalRegistry === undefined) delete process.env.npm_config_registry;
  else process.env.npm_config_registry = originalRegistry;
  if (originalUserConfig === undefined) delete process.env.npm_config_userconfig;
  else process.env.npm_config_userconfig = originalUserConfig;
});

test('plugin metadata uses the shared resolver with credential-safe URLs', async () => {
  process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
  process.env.npm_config_registry = 'https://user:p%40ss@mirror.example.com/custom/npm/';
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json({
    'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': {} },
  }));
  try {
    const response = await queryPluginRegistry(['@scope/credential-test']);
    assert.equal(response.results[0]?.kind, 'npm-ok');
    const [url, init] = fetch.mock.calls[0].arguments;
    assert.equal(String(url), 'https://mirror.example.com/custom/npm/@scope%2Fcredential-test');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
  } finally {
    fetch.mock.restore();
  }
});

const originalDateNow = Date.now;

afterEach(() => {
  Date.now = originalDateNow;
  clearNpmInfoCacheForTests();
});

const stubFetch = () =>
  mock.method(globalThis, 'fetch', async () =>
    Response.json({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }));

test('npm info cache sweeps expired entries for other names on access', async () => {
  process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
  delete process.env.npm_config_registry;
  let now = 1_000_000;
  Date.now = () => now;
  const fetch = stubFetch();
  try {
    await queryPluginRegistry(['sweep-alpha']);
    now += 3_600_001;
    await queryPluginRegistry(['sweep-beta']);
    assert.equal(fetch.mock.callCount(), 2);
    now = 1_001_000;
    await queryPluginRegistry(['sweep-alpha']);
    assert.equal(fetch.mock.callCount(), 3);
  } finally {
    fetch.mock.restore();
  }
});

test('npm info cache is capped, evicting the oldest entries', async () => {
  process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
  delete process.env.npm_config_registry;
  const fetch = stubFetch();
  try {
    const names = Array.from({ length: 501 }, (_, i) => `cap-eviction-${i}`);
    for (let i = 0; i < names.length; i += 100) {
      await queryPluginRegistry(names.slice(i, i + 100));
    }
    assert.equal(fetch.mock.callCount(), 501);
    await queryPluginRegistry(['cap-eviction-500']);
    assert.equal(fetch.mock.callCount(), 501);
    await queryPluginRegistry(['cap-eviction-0']);
    assert.equal(fetch.mock.callCount(), 502);
  } finally {
    fetch.mock.restore();
  }
});
