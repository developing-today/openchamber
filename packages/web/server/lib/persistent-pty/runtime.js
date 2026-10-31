import { WebSocket, WebSocketServer } from 'ws';

import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';

const PERSISTENT_PTY_CONNECT_PATH = /^\/api\/experimental\/persistent-pty\/([A-Za-z0-9_-]+)\/connect$/;

/** A handshake that has not completed by now is not going to (realtime-proxy precedent, #962). */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Bytes one client may queue while its upstream is still connecting (realtime-proxy's pre-open cap). */
const MAX_PENDING_BYTES = 256 * 1024;
/** A peer further behind than this after connect is closed as too slow (realtime-proxy precedent). */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

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
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  maxPendingBytes = MAX_PENDING_BYTES,
  maxBufferedBytes = MAX_BUFFERED_BYTES,
}) {
  const wsServer = new WebSocketServer({ noServer: true });

  wsServer.on('connection', (client, req) => {
    let upstream;
    try {
      upstream = new WebSocket(buildUpstreamUrl(buildOpenCodeUrl, req.url), {
        headers: getOpenCodeAuthHeaders(),
        origin: new URL(buildOpenCodeUrl('/', '')).origin,
        // A wedged upstream must fail the pair, not hold it open forever.
        handshakeTimeout: handshakeTimeoutMs,
      });
    } catch {
      client.close(1011, 'OpenCode service unavailable');
      return;
    }

    // The ws handshake timeout is not honoured on every runtime this
    // server runs on, so the bound is also kept here (the realtime proxy
    // keeps its own timer for the same reason): expiry kills the attempt
    // and fails the client instead of leaving its session open on a dead
    // upstream, and anything queued for it is dropped.
    const pending = [];
    let pendingBytes = 0;
    const handshakeTimer = setTimeout(() => {
      pending.length = 0;
      pendingBytes = 0;
      try { upstream.terminate(); } catch { /* already gone */ }
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        try { client.close(1011, 'Persistent PTY upstream handshake timed out'); } catch { /* already closing */ }
      }
    }, handshakeTimeoutMs);
    upstream.once('open', () => clearTimeout(handshakeTimer));
    upstream.once('error', () => clearTimeout(handshakeTimer));
    upstream.once('close', () => clearTimeout(handshakeTimer));
    client.once('close', () => clearTimeout(handshakeTimer));

    const closePair = (code, reason) => {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        try { client.close(code, reason); } catch { /* already closing */ }
      }
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        try { upstream.close(); } catch { /* already closing */ }
      }
    };

    // Forwarding ignores how far behind the receiving peer is falling;
    // past the bound the pair is closed instead of buffering without limit.
    const closeIfPeerTooSlow = (peer) => {
      if (peer.bufferedAmount <= maxBufferedBytes) return;
      closePair(1013, 'Persistent PTY peer is too slow');
    };

    const flush = () => {
      while (pending.length > 0 && upstream.readyState === WebSocket.OPEN) {
        const [data, isBinary] = pending.shift();
        upstream.send(data, { binary: isBinary });
      }
      pendingBytes = 0;
      closeIfPeerTooSlow(upstream);
    };

    client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
        closeIfPeerTooSlow(upstream);
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        pendingBytes += data.length;
        if (pendingBytes > maxPendingBytes) {
          // The handshake is stalled and the queue is full: drop the pair
          // rather than hold every byte until the upstream recovers, and
          // never flush what was queued.
          pending.length = 0;
          pendingBytes = 0;
          try { upstream.terminate(); } catch { /* already gone */ }
          if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            try { client.close(1013, 'Persistent PTY queue is full'); } catch { /* already closing */ }
          }
          return;
        }
        pending.push([data, isBinary]);
      }
    });
    upstream.on('open', flush);
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
        closeIfPeerTooSlow(client);
      }
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
