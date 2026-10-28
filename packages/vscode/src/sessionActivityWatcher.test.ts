import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionActivityV1Snapshot, getSessionActivitySnapshot } from './sessionActivityWatcher';

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
});
