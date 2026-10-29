import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readBoundedResponseText } from '../guests/response-body.js';

export const MCPX_DAEMON_TIMEOUT_MS = 10_000;
export const MCPX_DAEMON_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const timeoutError = (timeoutMs) => new Error(`mcpx daemon timed out after ${timeoutMs}ms`);
const tooLargeError = (maxBytes) => new Error(`mcpx daemon response exceeded ${maxBytes} bytes`);

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

export const callDaemon = async (reqPath, method = 'GET', body = null, headers = {}, options = {}) => {
  const timeoutMs = options.timeoutMs ?? MCPX_DAEMON_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MCPX_DAEMON_MAX_RESPONSE_BYTES;
  const endpoint = process.env.MCPX_DAEMON_ENDPOINT || process.env.MCPX_ENDPOINT;
  const socket = findDaemonSocket();

  if (endpoint && endpoint.startsWith('http')) {
    let res;
    try {
      res = await fetch(`${endpoint.replace(/\/+$/, '')}${reqPath}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw timeoutError(timeoutMs);
      throw err;
    }
    let bounded;
    try {
      bounded = await readBoundedResponseText(res, maxResponseBytes);
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw timeoutError(timeoutMs);
      throw err;
    }
    if (bounded.tooLarge) throw tooLargeError(maxResponseBytes);
    if (!res.ok) throw new Error(`mcpx daemon HTTP ${res.status}: ${bounded.text}`);
    return JSON.parse(bounded.text);
  }

  if (socket) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
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
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxResponseBytes) {
            fail(tooLargeError(maxResponseBytes));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const data = Buffer.concat(chunks, size).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`mcpx daemon HTTP ${res.statusCode}: ${data}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
        res.on('error', fail);
      });

      req.setTimeout(timeoutMs, () => {
        fail(timeoutError(timeoutMs));
        req.destroy();
      });
      req.on('error', fail);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  throw new Error('No mcpx daemon reachable');
};
