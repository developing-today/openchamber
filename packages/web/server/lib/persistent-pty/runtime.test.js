import { afterEach, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

import { createPersistentPtyWsRuntime } from './runtime.js';

const PTY_ID = 'pty_abc-123';
const CONNECT_PATH = `/api/experimental/persistent-pty/${PTY_ID}/connect`;

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const closeServer = (server) => new Promise((resolve) => server.close(() => resolve()));

const openSocket = (url, headers = {}) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { headers });
  const inbox = [];
  const waiters = [];
  socket.on('message', (data, isBinary) => {
    const message = { data: Buffer.from(data), isBinary };
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  socket.next = () => (inbox.length > 0
    ? Promise.resolve(inbox.shift())
    : new Promise((resolveNext) => waiters.push(resolveNext)));
  socket.once('open', () => resolve({ socket, opened: true }));
  socket.once('unexpected-response', (_req, res) => resolve({ socket, opened: false, status: res.statusCode }));
  socket.once('error', (error) => {
    if (socket.readyState !== WebSocket.OPEN) reject(error);
  });
});

const setupFixture = async ({ enabled = true, session = true, upstreamHandler, runtimeOptions = {}, upstreamPortOverride = null, verifyClientDelayMs = 0 } = {}) => {
  const upstreamReceived = [];
  const upstreamMessages = [];
  const upstreamHttp = http.createServer();
  const upstreamWssOptions = { server: upstreamHttp };
  if (verifyClientDelayMs > 0) {
    upstreamWssOptions.verifyClient = (_info, cb) => setTimeout(() => cb(true), verifyClientDelayMs);
  }
  const upstreamWss = new WebSocketServer(upstreamWssOptions);
  upstreamWss.on('connection', (ws, req) => {
    upstreamReceived.push({ url: req.url, origin: req.headers.origin, auth: req.headers.authorization });
    ws.on('message', (data, isBinary) => {
      upstreamMessages.push(Buffer.from(data));
      if (upstreamHandler) upstreamHandler(ws, data, isBinary);
      else ws.send(data, { binary: isBinary });
    });
    ws.send(JSON.stringify({ type: 'attached' }));
  });
  const listenedUpstreamPort = await listen(upstreamHttp);
  const upstreamPort = upstreamPortOverride ?? listenedUpstreamPort;
  cleanups.push(() => new Promise((resolve) => {
    upstreamWss.clients.forEach((client) => client.terminate());
    upstreamWss.close(() => closeServer(upstreamHttp).then(resolve));
  }));

  const server = http.createServer((_req, res) => res.end());
  const port = await listen(server);
  cleanups.push(() => closeServer(server));

  const runtime = createPersistentPtyWsRuntime({
    server,
    uiAuthController: { enabled, ensureSessionToken: async () => (session ? 'session' : null) },
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade: (socket, status, message) => {
      socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    },
    buildOpenCodeUrl: (path) => `http://127.0.0.1:${upstreamPort}${path}`,
    getOpenCodeAuthHeaders: () => ({ authorization: 'Basic b3Bj' }),
    ...runtimeOptions,
  });
  cleanups.push(() => runtime.close());

  return { port, upstreamReceived, upstreamMessages };
};

it('proxies framed input and output for a persistent PTY connection', async () => {
  const { port, upstreamReceived } = await setupFixture();
  const query = 'role=controller&input_protocol=1&location%5Bdirectory%5D=%2Ftmp%2Fproj&ticket=ignored';
  const { socket, opened } = await openSocket(`ws://127.0.0.1:${port}${CONNECT_PATH}?${query}`);
  expect(opened).toBe(true);

  const attached = await socket.next();
  expect(JSON.parse(attached.data.toString())).toEqual({ type: 'attached' });

  const frame = Buffer.concat([Buffer.from([1, 0, 120, 0, 40]), Buffer.from('ls\r')]);
  socket.send(frame);
  const echoed = await socket.next();
  expect(echoed.data).toEqual(frame);
  expect(echoed.isBinary).toBe(true);

  expect(upstreamReceived).toHaveLength(1);
  const upstream = new URL(upstreamReceived[0].url, 'http://127.0.0.1');
  expect(upstream.pathname).toBe(CONNECT_PATH);
  expect(upstream.searchParams.get('role')).toBe('controller');
  expect(upstream.searchParams.get('input_protocol')).toBe('1');
  expect(upstream.searchParams.get('location[directory]')).toBe('/tmp/proj');
  expect(upstream.searchParams.has('ticket')).toBe(false);
  expect(upstreamReceived[0].auth).toBe('Basic b3Bj');
  socket.close();
});

it('rejects the upgrade without a UI session when auth is enabled', async () => {
  const { port } = await setupFixture({ session: false });
  const result = await openSocket(`ws://127.0.0.1:${port}${CONNECT_PATH}?role=controller`);
  expect(result.opened).toBe(false);
  expect(result.status).toBe(401);
  result.socket.terminate();
});

const nextClose = (socket) => new Promise((resolve) => socket.once('close', (code) => resolve(code)));

// A raw TCP host for the upstream side: it can stall the handshake
// forever, or complete it by hand and then read nothing — the two stall
// shapes the bounds exist for. A real WebSocket server cannot be made to
// stall either way on every runtime.
const startRawHost = async ({ completeHandshake }) => {
  const state = { handshakes: 0, sockets: new Set() };
  const server = net.createServer((socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    let upgraded = false;
    let head = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (upgraded) return;
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1 || !completeHandshake) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head.subarray(0, end).toString())?.[1];
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      upgraded = true;
      state.handshakes += 1;
      socket.pause();
    });
  });
  const port = await listen(server);
  cleanups.push(() => new Promise((resolve) => {
    for (const socket of state.sockets) socket.destroy();
    server.close(() => resolve());
  }));
  return { port, state };
};

const waitFor = async (predicate, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

it('closes the client with 1011 when the upstream handshake never completes', async () => {
  const host = await startRawHost({ completeHandshake: false });
  const { port } = await setupFixture({
    upstreamPortOverride: host.port,
    runtimeOptions: { handshakeTimeoutMs: 300 },
  });
  const { socket, opened } = await openSocket(`ws://127.0.0.1:${port}${CONNECT_PATH}?role=controller`);
  expect(opened).toBe(true);
  const startedAt = Date.now();
  expect(await nextClose(socket)).toBe(1011);
  expect(Date.now() - startedAt).toBeLessThan(5_000);
}, 10_000);

it('drops the pair with 1013 when a client floods a stalled handshake past the pending bound', async () => {
  const host = await startRawHost({ completeHandshake: false });
  const { port } = await setupFixture({
    upstreamPortOverride: host.port,
    runtimeOptions: { handshakeTimeoutMs: 30_000, maxPendingBytes: 64 * 1024 },
  });
  const { socket, opened } = await openSocket(`ws://127.0.0.1:${port}${CONNECT_PATH}?role=controller`);
  expect(opened).toBe(true);
  const closed = nextClose(socket);
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  socket.send(chunk);
  socket.send(chunk);
  expect(await closed).toBe(1013);
  // The upstream attempt was terminated, not left holding the queue.
  await waitFor(() => host.state.sockets.size === 0);
  expect(host.state.sockets.size).toBe(0);
}, 10_000);

it('flushes input queued during a slow handshake in order once the upstream opens', async () => {
  const { port, upstreamMessages } = await setupFixture({ verifyClientDelayMs: 300 });
  const { socket, opened } = await openSocket(`ws://127.0.0.1:${port}${CONNECT_PATH}?role=controller`);
  expect(opened).toBe(true);
  socket.send('first');
  socket.send('second');
  const attached = await socket.next();
  expect(JSON.parse(attached.data.toString())).toEqual({ type: 'attached' });
  expect((await socket.next()).data.toString()).toBe('first');
  expect((await socket.next()).data.toString()).toBe('second');
  expect(upstreamMessages.map((message) => message.toString())).toEqual(['first', 'second']);
  socket.close();
}, 10_000);

it('closes the pair with 1013 when the upstream stops draining after connect', async () => {
  const host = await startRawHost({ completeHandshake: true });
  const { port } = await setupFixture({
    upstreamPortOverride: host.port,
    runtimeOptions: { maxBufferedBytes: 64 * 1024 },
  });
  const { socket, opened } = await openSocket(`ws://127.0.0.1:${port}${CONNECT_PATH}?role=controller`);
  expect(opened).toBe(true);
  const closed = nextClose(socket);
  await waitFor(() => host.state.handshakes === 1);
  expect(host.state.handshakes).toBe(1);
  const chunk = Buffer.alloc(64 * 1024, 0x62);
  let sent = 0;
  const TOTAL = 32 * 1024 * 1024;
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN || sent >= TOTAL) {
      if (sent >= TOTAL) clearInterval(timer);
      return;
    }
    sent += chunk.length;
    socket.send(chunk);
  }, 5);
  const code = await closed;
  clearInterval(timer);
  expect(code).toBe(1013);
  expect(sent).toBeLessThan(TOTAL);
}, 15_000);
