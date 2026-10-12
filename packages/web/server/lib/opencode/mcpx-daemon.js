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

export const callDaemon = async (reqPath, method = 'GET', body = null, headers = {}) => {
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
