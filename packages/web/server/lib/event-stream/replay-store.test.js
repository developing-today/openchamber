import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createReplayStore, resolveGlobalReplayFilePath } from './replay-store.js';

const directories = [];
const tempFile = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'openchamber-replay-'));
  directories.push(directory);
  return path.join(directory, 'global-replay.jsonl');
};

const entry = (position, upstream = '', now = 1_000) => ({
  position,
  upstream,
  eventId: `local-${position}`,
  serializedFrame: JSON.stringify({ type: 'event', eventId: `occ1.global.${position}.${upstream}` }),
  bytes: 10,
  committedAt: now,
});

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('replay store', () => {
  it('round-trips local frames, the head and a trim through the file', () => {
    const filePath = tempFile();
    const first = createReplayStore({ filePath });
    first.load();
    first.appendLocal(entry(2, 'inst-a:1'));
    first.appendHead({ position: 3, upstream: 'inst-a:2' });
    first.appendTrim(1);

    const second = createReplayStore({ filePath });
    const state = second.load();
    expect(state.head).toEqual({ position: 3, upstream: 'inst-a:2' });
    expect(state.entries).toEqual([entry(2, 'inst-a:1')]);
    expect(state.droppedLocalThroughPosition).toBe(1);
  });

  it('drops the entries a later reset forbids replaying', () => {
    const filePath = tempFile();
    const first = createReplayStore({ filePath });
    first.load();
    first.appendLocal(entry(2, 'inst-a:1'));
    first.appendReset({ position: 4, upstream: 'inst-b:0' });

    const state = createReplayStore({ filePath }).load();
    expect(state.head).toEqual({ position: 4, upstream: 'inst-b:0' });
    expect(state.entries).toEqual([]);
    expect(state.droppedLocalThroughPosition).toBe(4);
  });

  it('ignores a torn final record, as a killed process leaves it', () => {
    const filePath = tempFile();
    const store = createReplayStore({ filePath });
    store.load();
    store.appendLocal(entry(2, 'inst-a:1'));
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}{"v":1,"t":"local","entry":{"position":`);

    const state = createReplayStore({ filePath }).load();
    expect(state.entries).toEqual([entry(2, 'inst-a:1')]);
    expect(state.head).toEqual({ position: 2, upstream: 'inst-a:1' });
  });

  it('compacts the append log into a snapshot and still reloads it', () => {
    const filePath = tempFile();
    const store = createReplayStore({ filePath, compactAfterRecords: 2 });
    store.load();
    store.appendLocal(entry(2, 'inst-a:1'));
    store.appendHead({ position: 3, upstream: 'inst-a:2' });
    store.appendLocal(entry(4, 'inst-a:3'));

    const lines = readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.at(-1).t).toBe('snapshot');
    const state = createReplayStore({ filePath }).load();
    expect(state.head).toEqual({ position: 4, upstream: 'inst-a:3' });
    expect(state.entries.map((item) => item.position)).toEqual([2, 4]);
  });

  it('uses OPENCHAMBER_DATA_DIR for the global stream file', () => {
    expect(resolveGlobalReplayFilePath({ OPENCHAMBER_DATA_DIR: '/tmp/oc-data' }, '/home/me'))
      .toBe('/tmp/oc-data/event-stream/global-replay.jsonl');
    expect(resolveGlobalReplayFilePath({}, '/home/me'))
      .toBe('/home/me/.config/openchamber/event-stream/global-replay.jsonl');
  });
});
