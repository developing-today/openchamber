import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
};
