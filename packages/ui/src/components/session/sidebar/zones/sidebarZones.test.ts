import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { DEFAULT_SIDEBAR_LAYOUT, type SessionAttentionState, type SidebarLayout } from '@/stores/sidebarLayout';
import { partitionSidebarZones, reuseUnchangedPartition, type SidebarZonePartitionArgs } from './sidebarZones';

// SAFETY: the partition reads only the id and the directory through the injected predicates.
const session = (id: string, directory = '/repo'): Session => ({ id, directory, title: id, time: { created: 1, updated: 1 } } as Session);

const input = (
  roots: Session[],
  overrides: Partial<SidebarZonePartitionArgs> & { states?: Record<string, SessionAttentionState>; inWork?: string[]; pinned?: string[]; layout?: SidebarLayout } = {},
): SidebarZonePartitionArgs => {
  const { states = {}, inWork = [], pinned = [], ...rest } = overrides;
  return {
    roots,
    layout: DEFAULT_SIDEBAR_LAYOUT,
    showPinnedZone: true,
    showWorkZone: true,
    isPinned: (candidate) => pinned.includes(candidate.id),
    isInWork: (candidate) => inWork.includes(candidate.id),
    isChat: (candidate) => candidate.directory === '/chats',
    liveStateById: new Map(Object.entries(states).map(([id, state]) => [id, { state, unread: false }])),
    held: null,
    ...rest,
  };
};

const zones = (partition: ReturnType<typeof partitionSidebarZones>): Record<string, string[]> => Object.fromEntries(
  [...partition.sessionsByZone].map(([zone, sessions]) => [zone, sessions.map((entry) => entry.id)]),
);

describe('partitionSidebarZones', () => {
  test('pulls followed sessions that need the user out of In work and Pinned, in lifecycle order', () => {
    const roots = [session('ask'), session('run'), session('fail'), session('pin-stop'), session('done'), session('other-fail')];
    const partition = partitionSidebarZones(input(roots, {
      inWork: ['ask', 'run', 'fail', 'done'],
      pinned: ['pin-stop'],
      states: { ask: 'question', run: 'running', fail: 'error', 'pin-stop': 'stopped', 'other-fail': 'error' },
    }));
    expect(zones(partition)).toEqual({ questions: ['ask'], work: ['run', 'done'], errors: ['fail'], stopped: ['pin-stop'] });
  });

  test('everything not running moves to Pending; running sessions stay in In work', () => {
    const partition = partitionSidebarZones(input([session('run'), session('idle')], {
      layout: { ...DEFAULT_SIDEBAR_LAYOUT, attention: 'pending' },
      inWork: ['run', 'idle'],
      states: { run: 'running' },
    }));
    expect(zones(partition)).toEqual({ work: ['run'], pending: ['idle'] });
  });

  test('other sessions, chats included, join zones and the active zone only when asked', () => {
    const roots = [session('chat-ask', '/chats'), session('plain-run'), session('plain-unread')];
    const layout: SidebarLayout = { ...DEFAULT_SIDEBAR_LAYOUT, otherAttention: 'separate', otherActive: true };
    const partition = partitionSidebarZones(input(roots, {
      layout,
      states: { 'chat-ask': 'approval', 'plain-run': 'running' },
      liveStateById: new Map([
        ['chat-ask', { state: 'approval', unread: false }],
        ['plain-run', { state: 'running', unread: false }],
        ['plain-unread', { state: 'idle', unread: true }],
      ]),
    }));
    expect(zones(partition)).toEqual({ 'other-approvals': ['chat-ask'], 'other-active': ['plain-run', 'plain-unread'] });
    expect(zones(partitionSidebarZones(input(roots, { states: { 'chat-ask': 'approval' } })))).toEqual({});
  });

  test('keeps the held session in its zone, or out of every zone, and reports where it would be', () => {
    const roots = [session('held'), session('other')];
    const base = { inWork: ['held', 'other'], states: { held: 'question' as const } };
    const heldInWork = partitionSidebarZones(input(roots, { ...base, held: { sessionId: 'held', zone: 'work' } }));
    expect(zones(heldInWork)).toEqual({ work: ['held', 'other'] });
    expect(heldInWork.naturalZoneBySessionId.get('held')).toBe('questions');

    const heldOut = partitionSidebarZones(input(roots, { ...base, held: { sessionId: 'held', zone: null } }));
    expect(zones(heldOut)).toEqual({ work: ['other'] });
  });

  test('a held zone the layout no longer has gives way to the live one', () => {
    const partition = partitionSidebarZones(input([session('held')], {
      layout: { ...DEFAULT_SIDEBAR_LAYOUT, attention: 'combined' },
      inWork: ['held'],
      states: { held: 'question' },
      held: { sessionId: 'held', zone: 'questions' },
    }));
    expect(zones(partition)).toEqual({ attention: ['held'] });
  });

  test('reuses the previous partition while every zone holds the same sessions', () => {
    const roots = [session('a'), session('b')];
    const first = partitionSidebarZones(input(roots, { inWork: ['a'] }));
    const second = partitionSidebarZones(input(roots, { inWork: ['a'] }));
    expect(reuseUnchangedPartition(first, second)).toBe(first);
    const changed = partitionSidebarZones(input(roots, { inWork: ['a', 'b'] }));
    expect(reuseUnchangedPartition(first, changed)).toBe(changed);
  });
});
