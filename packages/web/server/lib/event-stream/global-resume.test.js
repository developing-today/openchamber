import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';
import { createGlobalMessageStreamWsBridge } from './global-ws-bridge.js';
import { createMessageStreamWsRuntime } from './runtime.js';

// OpenCode's side of the contract (packages/server/src/event-feed.ts): every frame carries
// `id: <instance>:<sequence>`. A cursor from this instance is replayed from a bounded window; any
// other cursor, or one that has aged out, is answered with one `server.resync` frame at the head.
function createFakeOpenCode({ instance = randomUUID(), windowFrames = 1024 } = {}) {
  let sequence = 0;
  const retained = [];
  const live = new Set();
  const cursors = [];
  const idOf = (seq) => `${instance}:${seq}`;
  const frameOf = (event, id) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
  const sequenceOf = (cursor) => {
    if (!cursor.startsWith(`${instance}:`)) return undefined;
    const digits = cursor.slice(instance.length + 1);
    return /^\d+$/.test(digits) ? Number(digits) : undefined;
  };

  const feed = {
    instance,
    cursors,
    get connections() {
      return cursors.length;
    },
    // Publishes one event: the feed retains it, and every open stream receives it.
    publish() {
      sequence += 1;
      const frame = frameOf({ id: `evt_${sequence}`, type: 'message.updated', properties: { n: sequence } }, idOf(sequence));
      retained.push({ seq: sequence, frame });
      if (retained.length > windowFrames) retained.shift();
      for (const connection of live) connection.push(frame);
      return idOf(sequence);
    },
    // Ends every open stream, as a dropped connection would.
    cut() {
      for (const connection of Array.from(live)) connection.end();
      live.clear();
    },
    fetch(_url, { headers = {}, signal } = {}) {
      const connection = createConnection(signal, () => live.delete(connection));
      const cursor = headers['Last-Event-ID'] ?? '';
      cursors.push(cursor);
      if (cursor) {
        const after = sequenceOf(cursor);
        const oldest = retained[0]?.seq ?? sequence + 1;
        if (after === undefined || after < oldest - 1 || after > sequence) {
          connection.push(frameOf({ id: 'evt_resync', type: 'server.resync', data: {} }, idOf(sequence)));
        } else {
          for (const entry of retained) if (entry.seq > after) connection.push(entry.frame);
        }
      }
      live.add(connection);
      return Promise.resolve({ ok: true, status: 200, body: connection.body });
    },
  };
  return feed;
}

// A response body that yields what is pushed to it, and ends when told to or when aborted.
function createConnection(signal, onClose) {
  const encoder = new TextEncoder();
  const chunks = [];
  let ended = false;
  let wake = null;
  const notify = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const end = () => {
    ended = true;
    onClose();
    notify();
  };
  signal?.addEventListener('abort', end, { once: true });
  const connection = {
    push(text) {
      if (ended) return;
      chunks.push(text);
      notify();
    },
    end,
    body: {
      getReader() {
        return {
          async read() {
            for (;;) {
              if (chunks.length > 0) return { value: encoder.encode(chunks.shift()), done: false };
              if (ended || signal?.aborted) return { value: undefined, done: true };
              await new Promise((resolve) => { wake = resolve; });
            }
          },
          async cancel() {
            end();
          },
        };
      },
    },
  };
  return connection;
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  ping() {
    void 0;
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

const createHub = (fetchImpl, overrides = {}) => createGlobalMessageStreamHub({
  buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
  getOpenCodeAuthHeaders: () => ({}),
  fetchImpl,
  upstreamStallTimeoutMs: 0,
  upstreamReconnectDelayMs: 0,
  ...overrides,
});
// A block-driven upstream ends its stream after the blocks: hold the reconnect back so it does not spin.
const HOLD_RECONNECT = { upstreamReconnectDelayMs: 60_000 };

const createRuntime = (hub) => createMessageStreamWsRuntime({
  server: new EventEmitter(),
  globalEventHub: hub,
  wsClients: new Set(),
  uiAuthController: null,
  isRequestOriginAllowed: async () => true,
  rejectWebSocketUpgrade() {},
  buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
  getOpenCodeAuthHeaders: () => ({}),
  processForwardedEventPayload() {},
  heartbeatIntervalMs: 60_000,
});

const connect = (runtime, lastEventId) => {
  const socket = new FakeSocket();
  const query = lastEventId ? `?lastEventId=${encodeURIComponent(lastEventId)}` : '';
  runtime.wsServer.emit('connection', socket, { url: `/api/global/event/ws${query}` });
  return socket;
};

const eventIds = (socket) => socket.sent.filter((frame) => frame.type === 'event').map((frame) => frame.eventId);
const readyFrames = (socket) => socket.sent.filter((frame) => frame.type === 'ready');

describe('global hub: upstream ids and resync', () => {
  it('keys the replay buffer by the upstream id line, and passes a resync on without buffering it', async () => {
    const instance = randomUUID();
    const block = (seq, body) => `id: ${instance}:${seq}\ndata: ${JSON.stringify(body)}\n\n`;
    const blocks = [
      block(1, { id: 'evt_a', type: 'message.updated', properties: {} }),
      block(2, { id: 'evt_resync', type: 'server.resync', data: {} }),
      block(3, { id: 'evt_b', type: 'message.updated', properties: {} }),
    ];
    const encoder = new TextEncoder();
    let index = 0;
    const hub = createHub(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          async read() {
            if (index < blocks.length) return { value: encoder.encode(blocks[index++]), done: false };
            return { value: undefined, done: true };
          },
        }),
      },
    }), HOLD_RECONNECT);
    const received = [];
    hub.subscribeEvent((event) => received.push({ eventId: event.eventId, resync: event.resync }));
    try {
      hub.start();
      await expect.poll(() => received.length).toBe(3);
      expect(received).toEqual([
        { eventId: `${instance}:1`, resync: false },
        { eventId: `${instance}:2`, resync: true },
        { eventId: `${instance}:3`, resync: false },
      ]);
      // The payload's own id is not a cursor OpenCode can replay from.
      expect(hub.replayAfter('evt_a')).toBeNull();
      // The resync cleared what came before it: nothing replays across it.
      expect(hub.replayAfter(`${instance}:1`)).toBeNull();
      expect(hub.replayAfter(`${instance}:2`)).toBeNull();
      expect(hub.replayAfter(`${instance}:3`)).toEqual([]);
      expect(hub.upstreamCursor()).toBe(`${instance}:3`);
    } finally {
      hub.stop();
    }
  });

  it('leaves the upstream cursor where it was for a block that carries no id line', async () => {
    const instance = randomUUID();
    const encoder = new TextEncoder();
    const blocks = [
      `id: ${instance}:1\ndata: ${JSON.stringify({ id: 'evt_a', type: 'message.updated', properties: {} })}\n\n`,
      // OpenCode sends `server.connected` outside its feed, so it has no id line.
      `data: ${JSON.stringify({ id: 'evt_connected', type: 'server.connected', data: {} })}\n\n`,
    ];
    let index = 0;
    const hub = createHub(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          async read() {
            if (index < blocks.length) return { value: encoder.encode(blocks[index++]), done: false };
            return { value: undefined, done: true };
          },
        }),
      },
    }), HOLD_RECONNECT);
    const received = [];
    hub.subscribeEvent((event) => received.push(event.eventId));
    try {
      hub.start();
      await expect.poll(() => received.length).toBe(2);
      expect(received).toEqual([`${instance}:1`, 'evt_connected']);
      // The reconnect cursor stays an OpenCode id, so OpenCode can replay from it.
      expect(hub.upstreamCursor()).toBe(`${instance}:1`);
      expect(hub.replayAfter(`${instance}:1`)).toEqual([expect.objectContaining({ eventId: 'evt_connected' })]);
    } finally {
      hub.stop();
    }
  });

  it('records, per client, the last upstream id it was sent', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const bridge = createGlobalMessageStreamWsBridge({
      globalHub: hub,
      ownsGlobalHub: true,
      wsClients: new Set(),
      processForwardedEventPayload() {},
      triggerHealthCheck() {},
      heartbeatIntervalMs: 60_000,
    });
    const socket = new FakeSocket();
    try {
      bridge.accept(socket, { requestedLastEventId: '' });
      await expect.poll(() => feed.connections).toBe(1);
      await expect.poll(() => readyFrames(socket).length).toBe(1);
      feed.publish();
      const last = feed.publish();
      await expect.poll(() => eventIds(socket).length).toBe(2);
      expect(bridge.lastEventIdOf(socket)).toBe(last);
    } finally {
      socket.close();
      bridge.close();
    }
  });
});

describe('WebSocket resume through the global hub', () => {
  it('delivers exactly the events missed across an upstream disconnect, once and in order', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      await expect.poll(() => feed.connections).toBe(1);
      const ids = [feed.publish(), feed.publish(), feed.publish()];
      await expect.poll(() => eventIds(browser).length).toBe(3);

      feed.cut();
      ids.push(feed.publish(), feed.publish());
      await expect.poll(() => feed.connections).toBe(2);
      ids.push(feed.publish());

      await expect.poll(() => eventIds(browser).length).toBe(6);
      expect(eventIds(browser)).toEqual(ids);
      // The hub passed its own cursor upstream, so OpenCode replayed from it.
      expect(feed.cursors[1]).toBe(ids[2]);
      // The first connect is as it always was; the reconnect resumed and so needs no refetch.
      expect(readyFrames(browser)).toEqual([
        { type: 'ready', scope: 'global' },
        { type: 'ready', scope: 'global', resumed: true },
      ]);
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('resumes a browser across an OpenChamber restart: the missed events once, and no refetch', async () => {
    const feed = createFakeOpenCode();
    const hub1 = createHub(feed.fetch);
    const runtime1 = createRuntime(hub1);
    const before = connect(runtime1);
    await expect.poll(() => feed.connections).toBe(1);
    await expect.poll(() => readyFrames(before).length).toBe(1);
    feed.publish();
    feed.publish();
    const third = feed.publish();
    await expect.poll(() => eventIds(before).length).toBe(3);
    const cursor = eventIds(before).at(-1);
    expect(cursor).toBe(third);

    // OpenChamber restarts: its hub and sockets go away. OpenCode keeps running and keeps publishing.
    before.close();
    await runtime1.close();
    hub1.stop();
    const missed = [feed.publish(), feed.publish()];

    const hub2 = createHub(feed.fetch);
    const runtime2 = createRuntime(hub2);
    const after = connect(runtime2, cursor);
    try {
      await expect.poll(() => readyFrames(after).length).toBe(1);
      expect(readyFrames(after)[0]).toEqual({ type: 'ready', scope: 'global', resumed: true });
      await expect.poll(() => eventIds(after).length).toBe(2);
      expect(eventIds(after)).toEqual(missed);

      // Live events after the restart reach the browser once, whichever path carries them.
      const live = feed.publish();
      await expect.poll(() => eventIds(after).length).toBe(3);
      const last = feed.publish();
      await expect.poll(() => eventIds(after).length).toBe(4);
      expect(eventIds(after)).toEqual([...missed, live, last]);
      expect(readyFrames(after)).toHaveLength(1);
    } finally {
      after.close();
      hub2.stop();
      await runtime2.close();
    }
  });

  it('answers a cursor from another OpenCode instance with a refetch, and replays nothing', async () => {
    const feed = createFakeOpenCode();
    feed.publish();
    feed.publish();
    feed.publish();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const foreign = connect(runtime, `${randomUUID()}:7`);
    try {
      await expect.poll(() => readyFrames(foreign).length).toBe(2);
      expect(readyFrames(foreign)).toEqual([
        { type: 'ready', scope: 'global', resumed: true },
        { type: 'ready', scope: 'global', replayReset: true },
      ]);
      expect(eventIds(foreign)).toEqual([]);

      // Live from then on: the refetch repairs the gap, and the stream carries the rest.
      const live = feed.publish();
      await expect.poll(() => eventIds(foreign).length).toBe(1);
      expect(eventIds(foreign)).toEqual([live]);
    } finally {
      foreign.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('tells the ready clients to refetch when OpenCode resyncs the shared stream', async () => {
    let current = createFakeOpenCode();
    const hub = createHub((url, options) => current.fetch(url, options));
    const runtime = createRuntime(hub);
    const browser = connect(runtime);
    try {
      await expect.poll(() => readyFrames(browser).length).toBe(1);
      current.publish();
      current.publish();
      await expect.poll(() => eventIds(browser).length).toBe(2);

      // OpenCode restarts: a new instance answers the old cursor with a resync.
      const restarted = createFakeOpenCode();
      const previous = current;
      current = restarted;
      previous.cut();
      // The reconnect is announced as resumed before OpenCode's answer is known; the answer then
      // turns the client's state into a refetch.
      await expect.poll(() => readyFrames(browser).length).toBe(3);
      expect(readyFrames(browser).slice(1)).toEqual([
        { type: 'ready', scope: 'global', resumed: true },
        { type: 'ready', scope: 'global', replayReset: true },
      ]);
      expect(restarted.cursors[0]).toMatch(/^[0-9a-f-]{36}:2$/);

      const live = restarted.publish();
      await expect.poll(() => eventIds(browser).length).toBe(3);
      expect(eventIds(browser)[2]).toBe(live);
    } finally {
      browser.close();
      hub.stop();
      await runtime.close();
    }
  });

  it('keeps the older clients as they were: no cursor is a first connect, and a legacy cursor is reset', async () => {
    const feed = createFakeOpenCode();
    const hub = createHub(feed.fetch);
    const runtime = createRuntime(hub);
    const first = connect(runtime);
    await expect.poll(() => readyFrames(first).length).toBe(1);
    feed.publish();
    await expect.poll(() => eventIds(first).length).toBe(1);

    const legacy = connect(runtime, 'evt_from_an_older_hub');
    try {
      await expect.poll(() => readyFrames(legacy).length).toBe(1);
      expect(readyFrames(first)).toEqual([{ type: 'ready', scope: 'global' }]);
      expect(readyFrames(legacy)).toEqual([{ type: 'ready', scope: 'global', replayReset: true }]);
      expect(eventIds(legacy)).toEqual([]);
    } finally {
      first.close();
      legacy.close();
      hub.stop();
      await runtime.close();
    }
  });
});
