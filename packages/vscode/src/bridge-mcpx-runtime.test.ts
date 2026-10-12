import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { handleMcpxBridgeMessage } from './bridge-mcpx-runtime';

const SECRET = 'sk-test-7f3a9c-do-not-log';
const PENDING_REQUEST = {
  id: 'req_42',
  server: 'github',
  secrets: ['GITHUB_TOKEN'],
  status: 'pending',
  createdAt: '2026-10-11T09:00:00Z',
  message: 'github needs GITHUB_TOKEN',
};
const NAME_REFUSAL = {
  status: 400,
  body: { error: 'A secret name is an environment variable name, such as GITHUB_TOKEN' },
};
const ENTERPRISE_REFUSAL = {
  status: 403,
  body: { error: 'MCP server secrets are not available in enterprise mode.', code: 'enterprise_mode' },
};

type FakeDaemon = { server: http.Server; calls: string[] };

// A stand-in for the mcpx daemon on a Unix socket. It records every call, and a
// stored value comes back in its reply, which the bridge must not pass on.
const startFakeDaemon = (socketPath: string) => new Promise<FakeDaemon>((resolve) => {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/secret-requests') return res.end(JSON.stringify({ requests: [PENDING_REQUEST] }));
      if (req.url === '/v1/secrets') return res.end(JSON.stringify({ secrets: [{ name: 'GITHUB_TOKEN', set: false, source: null }] }));
      if (req.method === 'PUT') return res.end(JSON.stringify({ name: 'GITHUB_TOKEN', set: true, source: 'runtime', value: raw }));
      return res.end(JSON.stringify({ id: 'req_42', status: 'declined' }));
    });
  });
  server.listen(socketPath, () => resolve({ server, calls }));
});

describe('handleMcpxBridgeMessage', () => {
  const ENV_NAMES = ['MCPX_SOCKET', 'MCPX_STATE_DIR', 'MCPX_DAEMON_ENDPOINT', 'OPENCHAMBER_ENTERPRISE_MODE'] as const;
  const saved = new Map<string, string | undefined>();
  let dir = '';
  let daemon: FakeDaemon | null = null;

  const stopDaemon = () => new Promise<void>((resolve) => {
    if (!daemon) return resolve();
    daemon.server.closeAllConnections();
    daemon.server.close(() => resolve());
    daemon = null;
  });

  beforeEach(async () => {
    for (const name of ENV_NAMES) saved.set(name, process.env[name]);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpx-bridge-'));
    // The state directory is the test's own, so a real daemon on this machine is never reached.
    process.env.MCPX_STATE_DIR = dir;
    process.env.MCPX_SOCKET = path.join(dir, 'daemon.sock');
    delete process.env.MCPX_DAEMON_ENDPOINT;
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '';
    daemon = await startFakeDaemon(process.env.MCPX_SOCKET);
  });

  afterEach(async () => {
    await stopDaemon();
    for (const name of ENV_NAMES) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('answers the secret messages through the daemon, and never returns a stored value', async () => {
    const stored = await handleMcpxBridgeMessage({
      id: 'store',
      type: 'api:mcpx/secrets:store',
      payload: { name: 'GITHUB_TOKEN', value: SECRET },
    });
    assert.deepEqual(stored?.data, { status: 200, body: { name: 'GITHUB_TOKEN', set: true, source: 'runtime' } });
    assert.equal(JSON.stringify(stored).includes(SECRET), false);

    const requests = await handleMcpxBridgeMessage({ id: 'list', type: 'api:mcpx/secret-requests' });
    assert.deepEqual(requests?.data, { status: 200, body: { requests: [PENDING_REQUEST] } });

    const names = await handleMcpxBridgeMessage({ id: 'names', type: 'api:mcpx/secrets' });
    assert.deepEqual(names?.data, { status: 200, body: { secrets: [{ name: 'GITHUB_TOKEN', set: false, source: null }] } });

    const declined = await handleMcpxBridgeMessage({
      id: 'decline',
      type: 'api:mcpx/secret-requests:decline',
      payload: { requestId: 'req_42' },
    });
    assert.deepEqual(declined?.data, { status: 200, body: { id: 'req_42', status: 'declined' } });
    assert.deepEqual(daemon?.calls, [
      'PUT /v1/secrets/GITHUB_TOKEN',
      'GET /v1/secret-requests',
      'GET /v1/secrets',
      'DELETE /v1/secret-requests/req_42',
    ]);
  });

  test('refuses every secret message in enterprise mode, without reaching the daemon', async () => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    const messages = [
      { id: 'list', type: 'api:mcpx/secret-requests' },
      { id: 'names', type: 'api:mcpx/secrets' },
      { id: 'store', type: 'api:mcpx/secrets:store', payload: { name: 'GITHUB_TOKEN', value: SECRET } },
      { id: 'decline', type: 'api:mcpx/secret-requests:decline', payload: { requestId: 'req_42' } },
    ];
    for (const message of messages) {
      const response = await handleMcpxBridgeMessage(message);
      assert.deepEqual(response?.data, ENTERPRISE_REFUSAL);
    }
    assert.deepEqual(daemon?.calls, []);
  });

  test('checks the secret name and the request id before calling the daemon', async () => {
    const badName = await handleMcpxBridgeMessage({
      id: 'store',
      type: 'api:mcpx/secrets:store',
      payload: { name: 'HAS-DASH', value: SECRET },
    });
    assert.deepEqual(badName?.data, NAME_REFUSAL);

    const missingName = await handleMcpxBridgeMessage({
      id: 'store-missing',
      type: 'api:mcpx/secrets:store',
      payload: { value: SECRET },
    });
    assert.deepEqual(missingName?.data, NAME_REFUSAL);

    const badId = await handleMcpxBridgeMessage({
      id: 'decline',
      type: 'api:mcpx/secret-requests:decline',
      payload: { requestId: 'a b' },
    });
    assert.deepEqual(badId?.data, { status: 400, body: { error: 'Invalid secret request id' } });
    assert.deepEqual(daemon?.calls, []);
  });

  test('answers 502 without the daemon text when no daemon is reachable', async () => {
    await stopDaemon();
    const response = await handleMcpxBridgeMessage({
      id: 'store',
      type: 'api:mcpx/secrets:store',
      payload: { name: 'GITHUB_TOKEN', value: SECRET },
    });
    assert.deepEqual(response?.data, { status: 502, body: { error: 'mcpx daemon did not store the secret' } });
  });

  test('leaves every other message to the other bridge runtimes', async () => {
    assert.equal(await handleMcpxBridgeMessage({ id: 'version', type: 'api:opencode/version' }), null);
    assert.deepEqual(daemon?.calls, []);
  });
});
