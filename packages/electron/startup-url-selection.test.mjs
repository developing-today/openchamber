import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStartupUrlProbePlan, shouldIgnoreLoopbackConnectionLimit } from './startup-url-selection.mjs';

test('bundled development never probes HMR endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: true,
    skipLocalServer: false,
  }), {
    probeHmrApi: false,
    probeHmrUi: false,
  });
});

test('HMR development probes both API and UI endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: false,
    skipLocalServer: false,
  }), {
    probeHmrApi: true,
    probeHmrUi: true,
  });
});

test('serverless HMR development skips only the local API probe', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: false,
    skipLocalServer: true,
  }), {
    probeHmrApi: false,
    probeHmrUi: true,
  });
});

test('production does not probe HMR endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: false,
    packagedUi: false,
    skipLocalServer: false,
  }), {
    probeHmrApi: false,
    probeHmrUi: false,
  });
});

test('keeps Chromium connection limits for the Vite HMR module graph', () => {
  assert.equal(shouldIgnoreLoopbackConnectionLimit({ development: true, packagedUi: false }), false);
  assert.equal(shouldIgnoreLoopbackConnectionLimit({ development: true, packagedUi: true }), true);
  assert.equal(shouldIgnoreLoopbackConnectionLimit({ development: false, packagedUi: false }), true);
});

test('a loopback server URL without a local server attaches as Local', async () => {
  const { resolveAttachedLocalServerUrl } = await import('./startup-url-selection.mjs');
  for (const serverUrl of ['http://127.0.0.1:3000', 'http://localhost:3000/', 'http://[::1]:3000']) {
    assert.equal(
      resolveAttachedLocalServerUrl({ skipLocalServer: true, serverUrl }),
      new URL(serverUrl).origin,
    );
  }
});

test('remote, sub-path and in-process setups do not attach as Local', async () => {
  const { resolveAttachedLocalServerUrl } = await import('./startup-url-selection.mjs');
  assert.equal(resolveAttachedLocalServerUrl({ skipLocalServer: false, serverUrl: 'http://127.0.0.1:3000' }), null);
  assert.equal(resolveAttachedLocalServerUrl({ skipLocalServer: true, serverUrl: 'http://192.168.1.5:3000' }), null);
  assert.equal(resolveAttachedLocalServerUrl({ skipLocalServer: true, serverUrl: 'https://example.com' }), null);
  assert.equal(resolveAttachedLocalServerUrl({ skipLocalServer: true, serverUrl: 'http://127.0.0.1:3000/openchamber' }), null);
  assert.equal(resolveAttachedLocalServerUrl({ skipLocalServer: true, serverUrl: 'ftp://127.0.0.1' }), null);
  assert.equal(resolveAttachedLocalServerUrl({ skipLocalServer: true, serverUrl: 'not a url' }), null);
  assert.equal(resolveAttachedLocalServerUrl({ skipLocalServer: true, serverUrl: '' }), null);
});
