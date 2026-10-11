import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import path from 'path';

import { registerOpenCodeProxy } from './lib/opencode/proxy.js';

// A stand-in for OpenCode's event stream, following the design in packages/core/TODO.md: every
// event carries an `id:`, a reconnect with Last-Event-ID replays what came after that id from a
// ring, and an id the ring does not hold (or one from another instance) gets a resync frame.
// The real OpenCode does not emit ids yet, so these tests exercise OpenChamber's side only.
const createFakeOpenCode = (instanceId = 'inst1') => {
  let currentInstance = instanceId;
  let sequence = 0;
  const ring = [];
  const live = new Set();
  const requests = [];

  const frame = (id, data) => `id: ${id}\ndata: ${data}\n\n`;

  const server = express();
  server.get('/api/event', (req, res) => {
    const lastEventId = req.headers['last-event-id'];
    requests.push({ lastEventId: lastEventId ?? null });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    if (lastEventId) {
      const index = ring.findIndex((entry) => entry.id === lastEventId);
      if (index === -1) {
        res.write('event: resync\ndata: {"type":"server.resync_required"}\n\n');
      } else {
        for (const entry of ring.slice(index + 1)) res.write(frame(entry.id, entry.data));
      }
    }

    const subscriber = { res };
    live.add(subscriber);
    req.on('close', () => live.delete(subscriber));
  });

  let httpServer = null;

  return {
    requests,
    listen: () => new Promise((resolve) => {
      httpServer = server.listen(0, '127.0.0.1', () => resolve(httpServer));
    }),
    port: () => httpServer.address().port,
    close: () => closeServer(httpServer),
    liveCount: () => live.size,
    // Records and delivers one event. With no stream connected it is still kept for replay.
    publish(data) {
      sequence += 1;
      const id = `${currentInstance}:${sequence}`;
      ring.push({ id, data });
      for (const subscriber of live) subscriber.res.write(frame(id, data));
      return id;
    },
    // Ends every live stream abruptly, optionally after writing the start of a block.
    dropAll({ partialBlock = '' } = {}) {
      for (const subscriber of [...live]) {
        const destroy = () => subscriber.res.socket?.destroy();
        // The partial block has to reach the wire before the socket goes, or it is never seen.
        if (partialBlock) subscriber.res.write(partialBlock, destroy);
        else destroy();
      }
      live.clear();
    },
    // A new OpenCode instance: a new id prefix and an empty ring.
    restartInstance(nextInstanceId) {
      currentInstance = nextInstanceId;
      sequence = 0;
      ring.length = 0;
    },
  };
};

const closeServer = (server) => new Promise((resolve) => {
  if (!server) {
    resolve();
    return;
  }
  server.closeAllConnections?.();
  server.close(() => resolve());
});

const startProxy = async ({ upstreamPort, resumeWindowMs = 2_000 }) => {
  const app = express();
  registerOpenCodeProxy(app, {
    fs: {},
    os: {},
    path,
    OPEN_CODE_READY_GRACE_MS: 0,
    SSE_HEARTBEAT_INTERVAL_MS: 60_000,
    SSE_RECONNECT_DELAY_MS: 5,
    SSE_RECONNECT_MAX_DELAY_MS: 20,
    SSE_RESUME_WINDOW_MS: resumeWindowMs,
    getRuntime: () => ({
      openCodePort: upstreamPort,
      isOpenCodeReady: true,
      openCodeNotReadySince: 0,
      isRestartingOpenCode: false,
    }),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
    ensureOpenCodeApiPrefix: () => {},
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
};

const waitFor = async (condition, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// What a browser's EventSource sees: each complete block, in order, with its id.
const openBrowserStream = async (url, headers = {}) => {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...headers },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const blocks = [];
  let pending = '';
  let ended = false;
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      for (let end = pending.indexOf('\n\n'); end !== -1; end = pending.indexOf('\n\n')) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (block.startsWith(':')) continue;
        const id = block.match(/^id: (.*)$/m)?.[1];
        const event = block.match(/^event: (.*)$/m)?.[1];
        const data = block.match(/^data: (.*)$/m)?.[1];
        blocks.push({ id, event, data });
      }
    }
    ended = true;
  })();
  return {
    blocks,
    ids: () => blocks.filter((block) => block.id !== undefined).map((block) => block.id),
    isEnded: () => ended,
    close: () => controller.abort(),
    pump,
  };
};

describe('OpenCode SSE resume through OpenChamber', () => {
  let upstream = null;
  let proxies = [];

  afterEach(async () => {
    for (const proxy of proxies) await closeServer(proxy);
    proxies = [];
    await closeServer(upstream?.httpServer);
    upstream = null;
  });

  const setup = async ({ resumeWindowMs } = {}) => {
    const fake = createFakeOpenCode();
    fake.httpServer = await fake.listen();
    upstream = fake;
    const proxy = await startProxy({ upstreamPort: fake.port(), resumeWindowMs });
    proxies.push(proxy);
    const base = `http://127.0.0.1:${proxy.address().port}`;
    return { fake, proxy, base };
  };

  it('reconnects to OpenCode after a clean drop and keeps the browser stream, with each missed event once and in order', async () => {
    const { fake, base } = await setup();
    const browser = await openBrowserStream(`${base}/api/global/event`);
    await waitFor(() => fake.liveCount() === 1);
    fake.publish('{"n":1}');
    fake.publish('{"n":2}');
    fake.publish('{"n":3}');
    await waitFor(() => browser.ids().length === 3);

    // OpenCode drops between blocks while three events happen: the proxy reconnects with the last
    // id it forwarded and OpenCode replays the three, then the stream goes live again.
    fake.dropAll();
    fake.publish('{"n":4}');
    fake.publish('{"n":5}');
    fake.publish('{"n":6}');
    await waitFor(() => fake.requests.length === 2 && browser.ids().length === 6);
    fake.publish('{"n":7}');
    await waitFor(() => browser.ids().length === 7);

    expect(browser.ids()).toEqual(['inst1:1', 'inst1:2', 'inst1:3', 'inst1:4', 'inst1:5', 'inst1:6', 'inst1:7']);
    expect(browser.blocks.map((block) => block.data)).toEqual(
      ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}', '{"n":5}', '{"n":6}', '{"n":7}'],
    );
    expect(fake.requests.map((request) => request.lastEventId)).toEqual([null, 'inst1:3']);
    browser.close();
  });

  it('ends the browser stream when OpenCode is cut mid-block, and the browser resumes exactly from its last whole id', async () => {
    const { fake, base } = await setup();
    const first = await openBrowserStream(`${base}/api/global/event`);
    await waitFor(() => fake.liveCount() === 1);
    fake.publish('{"n":1}');
    fake.publish('{"n":2}');
    fake.publish('{"n":3}');
    await waitFor(() => first.ids().length === 3);

    // The half of event 4 already reached the browser. The proxy cannot take that back, so it ends
    // the browser stream: the browser discards the half at end-of-stream, as EventSource does.
    fake.dropAll({ partialBlock: 'id: inst1:4\ndata: {"n":4' });
    fake.publish('{"n":4}');
    fake.publish('{"n":5}');
    await waitFor(() => first.isEnded());
    expect(first.ids()).toEqual(['inst1:1', 'inst1:2', 'inst1:3']);

    // EventSource reconnects with the last id it received, and the events after it come back whole.
    const second = await openBrowserStream(`${base}/api/global/event`, { 'Last-Event-ID': 'inst1:3' });
    await waitFor(() => second.ids().length === 2);
    fake.publish('{"n":6}');
    await waitFor(() => second.ids().length === 3);

    expect([...first.ids(), ...second.ids()]).toEqual(['inst1:1', 'inst1:2', 'inst1:3', 'inst1:4', 'inst1:5', 'inst1:6']);
    expect(second.blocks.map((block) => block.data)).toEqual(['{"n":4}', '{"n":5}', '{"n":6}']);
    expect(fake.requests.at(-1).lastEventId).toBe('inst1:3');
    second.close();
  });

  it('passes a resync frame through to the browser and restarts the cursor from nothing', async () => {
    const { fake, base } = await setup();
    const browser = await openBrowserStream(`${base}/api/global/event`);
    await waitFor(() => fake.liveCount() === 1);
    fake.publish('{"n":1}');
    fake.publish('{"n":2}');
    await waitFor(() => browser.ids().length === 2);

    // A new OpenCode instance: the cursor it is handed belongs to another instance, so it resyncs.
    fake.restartInstance('inst2');
    fake.dropAll();
    await waitFor(() => browser.blocks.some((block) => block.event === 'resync'));
    expect(fake.requests.map((request) => request.lastEventId)).toEqual([null, 'inst1:2']);
    expect(browser.blocks.find((block) => block.event === 'resync')).toEqual({
      id: undefined,
      event: 'resync',
      data: '{"type":"server.resync_required"}',
    });

    // The resync frame carried no id, so the cursor is empty: a reconnect now sends no Last-Event-ID.
    fake.dropAll();
    await waitFor(() => fake.requests.length === 3);
    expect(fake.requests[2].lastEventId).toBeNull();

    fake.publish('{"n":3}');
    await waitFor(() => browser.ids().includes('inst2:1'));
    browser.close();
  });

  it('keeps a browser stream through an OpenCode restart and resumes it from the same Last-Event-ID on a successor OpenChamber', async () => {
    const { fake, proxy, base } = await setup();
    const successorProxy = await startProxy({ upstreamPort: fake.port() });
    proxies.push(successorProxy);
    const successorBase = `http://127.0.0.1:${successorProxy.address().port}`;

    const browser = await openBrowserStream(`${base}/api/global/event`);
    await waitFor(() => fake.liveCount() === 1);
    fake.publish('{"n":1}');
    fake.publish('{"n":2}');
    fake.publish('{"n":3}');
    await waitFor(() => browser.ids().length === 3);

    // The first OpenChamber goes away. Events keep arriving on OpenCode while nothing serves the browser.
    browser.close();
    await closeServer(proxy);
    proxies = proxies.filter((entry) => entry !== proxy);
    fake.publish('{"n":4}');
    fake.publish('{"n":5}');

    // The browser's EventSource reconnects to the successor with the last id it received.
    const resumed = await openBrowserStream(`${successorBase}/api/global/event`, { 'Last-Event-ID': 'inst1:3' });
    await waitFor(() => resumed.ids().length === 2);
    fake.publish('{"n":6}');
    await waitFor(() => resumed.ids().length === 3);

    expect(resumed.ids()).toEqual(['inst1:4', 'inst1:5', 'inst1:6']);
    expect(resumed.blocks.map((block) => block.data)).toEqual(['{"n":4}', '{"n":5}', '{"n":6}']);
    expect(fake.requests.at(-1).lastEventId).toBe('inst1:3');
    resumed.close();
  });

  it('ends a browser stream once OpenCode has been gone longer than the resume window', async () => {
    const { fake, base } = await setup({ resumeWindowMs: 150 });
    const browser = await openBrowserStream(`${base}/api/global/event`);
    await waitFor(() => fake.liveCount() === 1);
    fake.publish('{"n":1}');
    await waitFor(() => browser.ids().length === 1);

    await closeServer(fake.httpServer);
    fake.httpServer = null;
    upstream = null;

    await waitFor(() => browser.isEnded(), 3_000);
    expect(browser.ids()).toEqual(['inst1:1']);
  });

  // Needs an OpenCode build that emits `id:` lines and replays from its ring (the design in
  // packages/core/TODO.md, not on OpenCode main yet). Until it lands, the fake above stands in for it.
  it.skip('resumes against a real OpenCode that emits id: lines and replays from its ring', () => {});
});
