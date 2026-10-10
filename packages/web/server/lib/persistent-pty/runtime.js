import { WebSocket, WebSocketServer } from 'ws';

import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';

const PERSISTENT_PTY_CONNECT_PATH = /^\/api\/experimental\/persistent-pty\/([A-Za-z0-9_-]+)\/connect$/;

const FORWARDED_QUERY_KEYS = new Set([
  'cursor',
  'role',
  'attachment_id',
  'takeover',
  'input_protocol',
  'location[directory]',
]);

const UNSENDABLE_CLOSE_CODES = new Set([1005, 1006, 1015]);

const parsePathname = (rawUrl) => {
  try {
    return new URL(rawUrl || '/', 'http://127.0.0.1').pathname;
  } catch {
    return '';
  }
};

const buildUpstreamUrl = (buildOpenCodeUrl, requestUrl) => {
  const pathname = parsePathname(requestUrl);
  const incoming = new URL(requestUrl, 'http://127.0.0.1').searchParams;
  const upstream = new URL(buildOpenCodeUrl(pathname, ''));
  upstream.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of incoming) {
    if (FORWARDED_QUERY_KEYS.has(key)) upstream.searchParams.append(key, value);
  }
  return upstream;
};

const safeCloseCode = (code) => (UNSENDABLE_CLOSE_CODES.has(code) ? 1011 : code || 1000);

export function createPersistentPtyWsRuntime({
  server,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
}) {
  const wsServer = new WebSocketServer({ noServer: true });

  wsServer.on('connection', (client, req) => {
    let upstream;
    try {
      upstream = new WebSocket(buildUpstreamUrl(buildOpenCodeUrl, req.url), {
        headers: getOpenCodeAuthHeaders(),
        origin: new URL(buildOpenCodeUrl('/', '')).origin,
      });
    } catch {
      client.close(1011, 'OpenCode service unavailable');
      return;
    }

    const pending = [];
    const flush = () => {
      while (pending.length > 0 && upstream.readyState === WebSocket.OPEN) {
        const [data, isBinary] = pending.shift();
        upstream.send(data, { binary: isBinary });
      }
    };

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        pending.push([data, isBinary]);
      }
    });
    upstream.on('open', flush);
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on('close', (code, reason) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(safeCloseCode(code), reason);
      }
    });
    upstream.on('error', () => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close(1011, 'OpenCode terminal upstream error');
      }
    });
    client.on('close', () => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    });
    client.on('error', () => {});
  });

  const handleUpgrade = async (req, socket, head) => {
    if (isOpaqueOriginRequest(req)) {
      rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
      return;
    }
    if (!uiAuthController?.enabled && !await isPasswordlessSocketOriginAllowed(req, isRequestOriginAllowed)) {
      rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
      return;
    }
    if (uiAuthController?.enabled) {
      const sessionToken = await uiAuthController.ensureSessionToken?.(req, null);
      if (!sessionToken) {
        rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
        return;
      }
      if (!await isRequestOriginAllowed(req)) {
        rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
        return;
      }
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      wsServer.emit('connection', ws, req);
    });
  };

  const upgradeHandler = (req, socket, head) => {
    if (!PERSISTENT_PTY_CONNECT_PATH.test(parsePathname(req.url))) return;
    void handleUpgrade(req, socket, head).catch(() => {
      rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
    });
  };

  server.on('upgrade', upgradeHandler);

  return {
    close() {
      server.off('upgrade', upgradeHandler);
      for (const client of wsServer.clients) client.terminate();
      wsServer.close();
    },
  };
}
