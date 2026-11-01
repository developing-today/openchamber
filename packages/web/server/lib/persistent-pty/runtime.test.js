import { afterEach, expect, it } from 'vitest';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import { PERSISTENT_PTY_UPSTREAM_WS_MAX_PAYLOAD_BYTES, PERSISTENT_PTY_WS_MAX_PAYLOAD_BYTES, createPersistentPtyWsRuntime } from './runtime.js';

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

const setupFixture = async ({ enabled = true, session = true, upstreamHandler } = {}) => {
  const upstreamReceived = [];
  const upstreamHttp = http.createServer();
  const upstreamWss = new WebSocketServer({ server: upstreamHttp });
  upstreamWss.on('connection', (ws, req) => {
    upstreamReceived.push({ url: req.url, origin: req.headers.origin, auth: req.headers.authorization });
    ws.on('message', (data, isBinary) => {
      if (upstreamHandler) upstreamHandler(ws, data, isBinary);
      else ws.send(data, { binary: isBinary });
    });
    ws.send(JSON.stringify({ type: 'attached' }));
  });
  const upstreamPort = await listen(upstreamHttp);
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
  });
  cleanups.push(() => runtime.close());

  return { port, upstreamReceived };
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

it('refuses a single frame over the maxPayload cap with 1009 and forwards nothing upstream', async () => {
  const forwarded = [];
  const { port } = await setupFixture({
    upstreamHandler: (_ws, data) => { forwarded.push(Buffer.from(data)); },
  });
  const { socket, opened } = await openSocket(`ws://127.0.0.1:${port}${CONNECT_PATH}?role=controller`);
  expect(opened).toBe(true);
  await socket.next();
  const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
  socket.send(Buffer.alloc(PERSISTENT_PTY_WS_MAX_PAYLOAD_BYTES + 1, 0x65));
  expect(await closed).toBe(1009);
  expect(forwarded).toEqual([]);
});

it('forwards a single frame at the maxPayload cap byte-identically', async () => {
  const { port } = await setupFixture();
  const { socket, opened } = await openSocket(`ws://127.0.0.1:${port}${CONNECT_PATH}?role=controller`);
  expect(opened).toBe(true);
  await socket.next();
  const frame = Buffer.alloc(PERSISTENT_PTY_WS_MAX_PAYLOAD_BYTES, 0x66);
  socket.send(frame);
  const echoed = await socket.next();
  expect(echoed.data).toEqual(frame);
  expect(echoed.isBinary).toBe(true);
  socket.close();
});

it('refuses a single upstream frame over the upstream maxPayload cap with 1009 and forwards nothing to the client', async () => {
  const { port } = await setupFixture({
    upstreamHandler: (ws, data) => {
      if (data.toString() === 'send-over-cap') {
        ws.send(Buffer.alloc(PERSISTENT_PTY_UPSTREAM_WS_MAX_PAYLOAD_BYTES + 1, 0x67));
      }
    },
  });
  const { socket, opened } = await openSocket(`ws://127.0.0.1:${port}${CONNECT_PATH}?role=controller`);
  expect(opened).toBe(true);
  await socket.next();
  const seen = [];
  socket.on('message', (data) => seen.push(Buffer.from(data)));
  const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
  socket.send(Buffer.from('send-over-cap'));
  expect(await closed).toBe(1009);
  expect(seen).toEqual([]);
});

it('forwards a single upstream frame at the upstream maxPayload cap byte-identically', async () => {
  const frame = Buffer.alloc(PERSISTENT_PTY_UPSTREAM_WS_MAX_PAYLOAD_BYTES, 0x68);
  const { port } = await setupFixture({
    upstreamHandler: (ws, data) => {
      if (data.toString() === 'send-at-cap') ws.send(frame);
    },
  });
  const { socket, opened } = await openSocket(`ws://127.0.0.1:${port}${CONNECT_PATH}?role=controller`);
  expect(opened).toBe(true);
  await socket.next();
  socket.send(Buffer.from('send-at-cap'));
  const delivered = await socket.next();
  expect(delivered.data).toEqual(frame);
  expect(delivered.isBinary).toBe(true);
  socket.close();
});

it('rejects the upgrade without a UI session when auth is enabled', async () => {
  const { port } = await setupFixture({ session: false });
  const result = await openSocket(`ws://127.0.0.1:${port}${CONNECT_PATH}?role=controller`);
  expect(result.opened).toBe(false);
  expect(result.status).toBe(401);
  result.socket.terminate();
});
