import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionActivityV1Snapshot,
  deleteSessionActivityEntry,
  getSessionActivitySnapshot,
  pruneStaleSessionActivityEntries,
  SESSION_ACTIVITY_IDLE_TTL_MS,
} from './sessionActivityWatcher';

describe('session-activity v1 envelope (design #612, #621)', () => {
  test('the bridge snapshot carries the v1 top-level keys and starts not ready', () => {
    const snapshot = getSessionActivitySnapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), ['serverTime', 'sessions', 'version', 'watcherReady']);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.watcherReady, false);
    assert.equal(Number.isFinite(snapshot.serverTime), true);
    assert.deepEqual(snapshot.sessions, {});
  });

  test('each session entry carries the v1 keys, with host-unsourced fields as null', () => {
    const phases = new Map([['session-1', { phase: 'busy' as const, updatedAt: 1234 }]]);
    const snapshot = buildSessionActivityV1Snapshot(phases, true, 5678);
    assert.deepEqual(snapshot, {
      version: 1,
      serverTime: 5678,
      watcherReady: true,
      sessions: {
        'session-1': {
          type: 'busy',
          lastActivityAt: 1234,
          status: null,
          model: null,
          toolInFlight: null,
        },
      },
    });
    assert.deepEqual(Object.keys(snapshot.sessions['session-1']).sort(), [
      'lastActivityAt',
      'model',
      'status',
      'toolInFlight',
      'type',
    ]);
  });

  test('a session deleted after going busy disappears from the snapshot; a live idle session remains (#999)', () => {
    const phases = new Map([
      ['deleted-session', { phase: 'busy' as const, updatedAt: 1000 }],
      ['live-session', { phase: 'idle' as const, updatedAt: 2000 }],
    ]);
    assert.equal(deleteSessionActivityEntry(phases, 'deleted-session'), true);
    assert.equal(deleteSessionActivityEntry(phases, 'deleted-session'), false);
    const snapshot = buildSessionActivityV1Snapshot(phases, true, 5678);
    assert.deepEqual(Object.keys(snapshot.sessions), ['live-session']);
    assert.equal(snapshot.sessions['live-session'].type, 'idle');
  });

  test('the stale prune removes only entries idle past the TTL (#999)', () => {
    const now = SESSION_ACTIVITY_IDLE_TTL_MS * 4;
    const phases = new Map([
      ['stale-idle', { phase: 'idle' as const, updatedAt: 0 }],
      ['long-busy', { phase: 'busy' as const, updatedAt: 0 }],
      ['fresh-idle', { phase: 'idle' as const, updatedAt: now }],
    ]);
    assert.deepEqual(pruneStaleSessionActivityEntries(phases, now), ['stale-idle']);
    assert.deepEqual(Array.from(phases.keys()).sort(), ['fresh-idle', 'long-busy']);
  });
});
