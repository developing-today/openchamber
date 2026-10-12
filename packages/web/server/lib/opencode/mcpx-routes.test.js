import http from 'node:http';
import { format } from 'node:util';

import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { registerMcpxRoutes } from './mcpx-routes.js';

const SECRET = 'sk-test-7f3a9c-do-not-log';
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];
const PENDING_REQUEST = {
  id: 'req_42',
  server: 'github',
  secrets: ['GITHUB_TOKEN'],
  status: 'pending',
  createdAt: '2026-10-11T09:00:00Z',
  message: 'github needs GITHUB_TOKEN',
};

// A stand-in for the mcpx daemon that follows the secrets contract. With `echo`
// set it repeats the stored value, which the proxy must not pass on.
const startFakeDaemon = async () => {
  const state = { calls: [], echo: false, failStore: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      state.calls.push({ method: req.method, path: req.url, body });
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && req.url === '/v1/secret-requests') {
        return send(200, { requests: [PENDING_REQUEST] });
      }
      if (req.method === 'GET' && req.url === '/v1/secrets') {
        return send(200, { secrets: [{ name: 'GITHUB_TOKEN', set: false, source: null }] });
      }
      const stored = /^\/v1\/secrets\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(req.url);
      if (req.method === 'PUT' && stored) {
        if (state.failStore) return send(500, { error: `could not store ${body.value}` });
        const payload = { name: stored[1], set: true, source: 'runtime' };
        if (state.echo) payload.value = body.value;
        return send(200, payload);
      }
      if (req.method === 'DELETE' && req.url.startsWith('/v1/secret-requests/')) {
        return send(200, { id: req.url.slice('/v1/secret-requests/'.length), status: 'declined' });
      }
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, server, state };
};

// Everything written to the console while `run` executes, as one string.
const captureConsole = async (run) => {
  const lines = [];
  const originals = CONSOLE_METHODS.map((method) => [method, console[method]]);
  for (const [method] of originals) console[method] = (...args) => { lines.push(format(...args)); };
  try {
    await run();
  } finally {
    for (const [method, original] of originals) console[method] = original;
  }
  return lines.join('\n');
};

describe('MCPX Server Routes', () => {
  it('registers /api/mcpx endpoints on express app', () => {
    const routes = [];
    const recorder = (method) => (path) => { routes.push(`${method} ${path}`); };
    const mockApp = { get: recorder('GET'), put: recorder('PUT'), delete: recorder('DELETE') };

    registerMcpxRoutes(mockApp);

    expect(routes).toContain('GET /api/mcpx/status');
    expect(routes).toContain('GET /api/mcpx/namespaces');
    expect(routes).toContain('GET /api/mcpx/tools');
    expect(routes).toContain('GET /api/mcpx/types');
    expect(routes).toContain('GET /api/mcpx/log');
    expect(routes).toContain('GET /api/mcpx/secret-requests');
    expect(routes).toContain('GET /api/mcpx/secrets');
    expect(routes).toContain('PUT /api/mcpx/secrets/:name');
    expect(routes).toContain('DELETE /api/mcpx/secret-requests/:id');
  });
});

describe('MCPX secret routes against a fake daemon', () => {
  let daemon;
  let server;
  let baseUrl;
  let previousEndpoint;
  const parseErrors = [];

  const putSecret = (name, value) => fetch(`${baseUrl}/api/mcpx/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });

  beforeAll(async () => {
    daemon = await startFakeDaemon();
    previousEndpoint = process.env.MCPX_DAEMON_ENDPOINT;
    process.env.MCPX_DAEMON_ENDPOINT = daemon.url;
    const app = express();
    registerMcpxRoutes(app);
    // Errors that reach the framework are logged there. Recording them shows
    // whether a secret route ever hands one over.
    app.use((error, _req, res, _next) => {
      parseErrors.push(error);
      res.status(500).end();
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (previousEndpoint === undefined) delete process.env.MCPX_DAEMON_ENDPOINT;
    else process.env.MCPX_DAEMON_ENDPOINT = previousEndpoint;
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await new Promise((resolve) => { daemon.server.close(resolve); daemon.server.closeAllConnections(); });
  });

  beforeEach(() => {
    daemon.state.calls.length = 0;
    daemon.state.echo = false;
    daemon.state.failStore = false;
    parseErrors.length = 0;
  });

  it('lists secret requests and secret names through the daemon', async () => {
    const requests = await fetch(`${baseUrl}/api/mcpx/secret-requests`);
    expect(requests.status).toBe(200);
    expect(requests.headers.get('cache-control')).toBe('no-store');
    expect(await requests.json()).toEqual({ requests: [PENDING_REQUEST] });

    const names = await fetch(`${baseUrl}/api/mcpx/secrets`);
    expect(names.status).toBe(200);
    expect(await names.json()).toEqual({ secrets: [{ name: 'GITHUB_TOKEN', set: false, source: null }] });
    expect(daemon.state.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/secret-requests',
      'GET /v1/secrets',
    ]);
  });

  it('stores a secret by forwarding its value to the daemon name route', async () => {
    const response = await putSecret('GITHUB_TOKEN', SECRET);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ name: 'GITHUB_TOKEN', set: true, source: 'runtime' });
    expect(daemon.state.calls).toEqual([{ method: 'PUT', path: '/v1/secrets/GITHUB_TOKEN', body: { value: SECRET } }]);
  });

  it('never returns the value, even when the daemon echoes it back', async () => {
    daemon.state.echo = true;
    const response = await putSecret('GITHUB_TOKEN', SECRET);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(SECRET);
  });

  it('refuses a name that is not an environment variable name before calling the daemon', async () => {
    for (const name of ['1LEADING', 'HAS-DASH', 'HAS.DOT', 'SPACE%20NAME', 'A'.repeat(129)]) {
      const response = await putSecret(name, SECRET);
      expect(response.status).toBe(400);
    }
    expect(daemon.state.calls).toEqual([]);
  });

  it('refuses a missing, empty, non-string or oversized value before calling the daemon', async () => {
    const bodies = [{}, { value: '' }, { value: 42 }, [SECRET], { value: 'x'.repeat(16 * 1024 + 1) }];
    for (const body of bodies) {
      const response = await fetch(`${baseUrl}/api/mcpx/secrets/GITHUB_TOKEN`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(daemon.state.calls).toEqual([]);
  });

  it('answers a body that does not parse without logging it or passing the error on', async () => {
    const logged = await captureConsole(async () => {
      const response = await fetch(`${baseUrl}/api/mcpx/secrets/GITHUB_TOKEN`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: `{"value":"${SECRET}`,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(SECRET);
    });
    expect(logged).not.toContain(SECRET);
    expect(parseErrors).toEqual([]);
    expect(daemon.state.calls).toEqual([]);
  });

  it('answers an oversized body with 413 and no value', async () => {
    const response = await fetch(`${baseUrl}/api/mcpx/secrets/GITHUB_TOKEN`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: `${SECRET}${'x'.repeat(70 * 1024)}` }),
    });
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain(SECRET);
    expect(parseErrors).toEqual([]);
    expect(daemon.state.calls).toEqual([]);
  });

  it('keeps the value out of the logs on a successful store', async () => {
    const logged = await captureConsole(() => putSecret('GITHUB_TOKEN', SECRET));
    expect(logged).not.toContain(SECRET);
  });

  it('maps a daemon failure to 502 without forwarding its text', async () => {
    daemon.state.failStore = true;
    const logged = await captureConsole(async () => {
      const response = await putSecret('GITHUB_TOKEN', SECRET);
      expect(response.status).toBe(502);
      const text = await response.text();
      expect(text).toContain('mcpx daemon did not store the secret');
      expect(text).not.toContain(SECRET);
    });
    expect(logged).not.toContain(SECRET);
  });

  it('declines a request by forwarding the delete to the daemon', async () => {
    const response = await fetch(`${baseUrl}/api/mcpx/secret-requests/req_42`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ id: 'req_42', status: 'declined' });
    expect(daemon.state.calls).toEqual([{ method: 'DELETE', path: '/v1/secret-requests/req_42', body: null }]);
  });

  it('refuses a request id that is not a plain identifier', async () => {
    const response = await fetch(`${baseUrl}/api/mcpx/secret-requests/${encodeURIComponent('a b')}`, { method: 'DELETE' });
    expect(response.status).toBe(400);
    expect(daemon.state.calls).toEqual([]);
  });

  it('reports an unreachable daemon as 502', async () => {
    process.env.MCPX_DAEMON_ENDPOINT = 'http://127.0.0.1:1';
    try {
      const response = await fetch(`${baseUrl}/api/mcpx/secret-requests`);
      expect(response.status).toBe(502);
    } finally {
      process.env.MCPX_DAEMON_ENDPOINT = daemon.url;
    }
  });

  describe('in enterprise mode', () => {
    let previousMode;

    beforeEach(() => {
      previousMode = process.env.OPENCHAMBER_ENTERPRISE_MODE;
      process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    });

    afterEach(() => {
      if (previousMode === undefined) delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
      else process.env.OPENCHAMBER_ENTERPRISE_MODE = previousMode;
    });

    it('refuses every secret route with 403 and never reaches the daemon', async () => {
      const responses = [
        await fetch(`${baseUrl}/api/mcpx/secret-requests`),
        await fetch(`${baseUrl}/api/mcpx/secrets`),
        await putSecret('GITHUB_TOKEN', SECRET),
        await fetch(`${baseUrl}/api/mcpx/secret-requests/req_42`, { method: 'DELETE' }),
      ];
      for (const response of responses) {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: 'MCP server secrets are not available in enterprise mode.',
          code: 'enterprise_mode',
        });
      }
      expect(daemon.state.calls).toEqual([]);
    });

    it('refuses a secret before its body is read, so an oversized value is never parsed', async () => {
      const response = await fetch(`${baseUrl}/api/mcpx/secrets/GITHUB_TOKEN`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: `${SECRET}${'x'.repeat(70 * 1024)}` }),
      });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(SECRET);
      expect(parseErrors).toEqual([]);
      expect(daemon.state.calls).toEqual([]);
    });

    it('reads the mode at each request, so the routes answer again once it is off', async () => {
      expect((await fetch(`${baseUrl}/api/mcpx/secret-requests`)).status).toBe(403);

      process.env.OPENCHAMBER_ENTERPRISE_MODE = '';
      const response = await fetch(`${baseUrl}/api/mcpx/secret-requests`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ requests: [PENDING_REQUEST] });
    });
  });
});
