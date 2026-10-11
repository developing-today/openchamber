import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { z } from 'zod';

// The only shape a secret name takes: an environment variable name.
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SECRET_VALUE_MAX_LENGTH = 16 * 1024;

const secretValueBody = z.object({
  value: z.string().min(1).max(SECRET_VALUE_MAX_LENGTH),
});

// A body that fails to parse can carry the secret inside the error object, and
// the framework logs the errors it is handed. These answers stay here, so the
// body never reaches a log.
const parseSecretBody = express.json({ limit: '64kb' });
const readSecretBody = (req, res, next) => parseSecretBody(req, res, (error) => {
  if (!error) return next();
  if (error.status === 413) return res.status(413).json({ error: 'The secret value is too large' });
  return res.status(400).json({ error: 'Send the secret as a JSON object with a value' });
});

const secretResponse = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

const defaultSocketPath = () => {
  if (process.env.MCPX_SOCKET) return process.env.MCPX_SOCKET;
  const stateDir = process.env.MCPX_STATE_DIR ||
    (process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, 'mcpx') :
    path.join(os.homedir(), '.local', 'state', 'mcpx'));
  return path.join(stateDir, 'daemon.sock');
};

const findDaemonSocket = () => {
  const direct = defaultSocketPath();
  if (fs.existsSync(direct)) return direct;

  const stateDir = process.env.MCPX_STATE_DIR ||
    (process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, 'mcpx') :
    path.join(os.homedir(), '.local', 'state', 'mcpx'));
  if (fs.existsSync(stateDir)) {
    try {
      const files = fs.readdirSync(stateDir).filter((f) => f.startsWith('daemon-') && f.endsWith('.json'));
      for (const file of files) {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf-8'));
          if (info.socket && fs.existsSync(info.socket)) return info.socket;
        } catch {}
      }
    } catch {}
  }
  return undefined;
};

const callDaemon = async (reqPath, method = 'GET', body = null, headers = {}) => {
  const endpoint = process.env.MCPX_DAEMON_ENDPOINT || process.env.MCPX_ENDPOINT;
  const socket = findDaemonSocket();

  if (endpoint && endpoint.startsWith('http')) {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}${reqPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`mcpx daemon HTTP ${res.status}: ${await res.text()}`);
    return await res.json();
  }

  if (socket) {
    return new Promise((resolve, reject) => {
      const opt = {
        socketPath: socket,
        path: reqPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      };

      const req = http.request(opt, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`mcpx daemon HTTP ${res.statusCode}: ${data}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  throw new Error('No mcpx daemon reachable');
};

export const registerMcpxRoutes = (app) => {
  // 1. GET /api/mcpx/status
  app.get('/api/mcpx/status', async (_req, res) => {
    try {
      const status = await callDaemon('/v1/status');
      res.json(status);
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });

  // 2. GET /api/mcpx/namespaces
  app.get('/api/mcpx/namespaces', async (_req, res) => {
    try {
      const namespaces = await callDaemon('/v1/namespaces');
      res.json(namespaces);
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });

  // 3. GET /api/mcpx/tools
  app.get('/api/mcpx/tools', async (req, res) => {
    try {
      const query = req.query.ns ? `?ns=${encodeURIComponent(req.query.ns)}` : '';
      const tools = await callDaemon(`/v1/tools${query}`);
      res.json(tools);
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });

  // 4. GET /api/mcpx/types
  app.get('/api/mcpx/types', async (req, res) => {
    try {
      const query = req.query.namespace ? `?namespace=${encodeURIComponent(req.query.namespace)}` : '';
      const types = await callDaemon(`/v1/types${query}`);
      res.json({ types });
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });

  // 5. GET /api/mcpx/log
  app.get('/api/mcpx/log', async (req, res) => {
    try {
      const query = req.query.since ? `?since=${encodeURIComponent(req.query.since)}` : '';
      const log = await callDaemon(`/v1/log${query}`);
      res.json(log);
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });

  // Secret prompts. The daemon keeps the values in memory; this server only
  // relays them, so no response or log here may carry a value.
  app.get('/api/mcpx/secret-requests', secretResponse, async (_req, res) => {
    try {
      res.json(await callDaemon('/v1/secret-requests'));
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });

  app.get('/api/mcpx/secrets', secretResponse, async (_req, res) => {
    try {
      res.json(await callDaemon('/v1/secrets'));
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });

  app.put('/api/mcpx/secrets/:name', secretResponse, readSecretBody, async (req, res) => {
    if (!SECRET_NAME.test(req.params.name)) {
      return res.status(400).json({ error: 'A secret name is an environment variable name, such as GITHUB_TOKEN' });
    }
    const body = secretValueBody.safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: `A secret value must be a non-empty string of at most ${SECRET_VALUE_MAX_LENGTH} characters` });
    }
    try {
      const stored = await callDaemon(`/v1/secrets/${encodeURIComponent(req.params.name)}`, 'PUT', { value: body.data.value });
      // Only these fields leave, so a daemon reply that echoed the value cannot pass it on.
      res.json({ name: stored.name, set: stored.set, source: stored.source });
    } catch {
      // The daemon's error text is not forwarded, since it could repeat the value.
      res.status(502).json({ error: 'mcpx daemon did not store the secret' });
    }
  });

  app.delete('/api/mcpx/secret-requests/:id', secretResponse, async (req, res) => {
    if (!SECRET_REQUEST_ID.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid secret request id' });
    }
    try {
      res.json(await callDaemon(`/v1/secret-requests/${encodeURIComponent(req.params.id)}`, 'DELETE'));
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });
};
