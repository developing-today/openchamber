import { describe, expect, test } from 'bun:test';

import type { SessionNode } from '@/components/session/sidebar/types';
import type { Session } from '@/lib/opencode/model';

import { buildRunLaneNode } from './mobileRunLaneTree';
import { getParentId } from './mobileSessionFields';

type FixtureSession = Session & { parentID?: string };
const session = (id: string, parentID?: string): Session => {
  const value: FixtureSession = {
    id,
    projectID: 'project',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    title: id,
    directory: '/workspace',
    time: { created: 1, updated: 1 },
  };
  if (parentID) value.parentID = parentID;
  return value;
};

/** The raw parent→children map the sheet builds over every session. */
const childrenBySessionId = (sessions: readonly Session[]): Map<string, Session[]> => {
  const children = new Map<string, Session[]>();
  for (const entry of sessions) {
    const parentId = getParentId(entry);
    if (!parentId) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(entry);
    children.set(parentId, siblings);
  }
  return children;
};

const collectIds = (node: SessionNode): string[] => [
  node.session.id,
  ...node.children.flatMap(collectIds),
];

describe('buildRunLaneNode', () => {
  test('nests subsessions under an acyclic lane unchanged', () => {
    const sessions = [session('lane'), session('child', 'lane'), session('grandchild', 'child')];
    const node = buildRunLaneNode(childrenBySessionId(sessions), sessions[0]);

    expect(collectIds(node)).toEqual(['lane', 'child', 'grandchild']);
    expect(node.worktree).toBeNull();
  });

  test('renders a lane in a two-session parent cycle once per session', () => {
    const sessions = [session('a', 'b'), session('b', 'a')];
    const node = buildRunLaneNode(childrenBySessionId(sessions), sessions[0]);

    expect(collectIds(node)).toEqual(['a', 'b']);
    expect(node.children[0]?.children).toEqual([]);
  });

  test('renders a self-parented lane with no children', () => {
    const sessions = [session('self', 'self')];
    const node = buildRunLaneNode(childrenBySessionId(sessions), sessions[0]);

    expect(collectIds(node)).toEqual(['self']);
    expect(node.children).toEqual([]);
  });

  test('drops a cycle below the lane, keeping the acyclic prefix', () => {
    const sessions = [
      session('lane'),
      session('child', 'lane'),
      session('x', 'y'),
      session('y', 'x'),
    ];
    // x and y are unreachable from the lane (their parents are each other),
    // so the lane tree is exactly the lane and its child.
    const node = buildRunLaneNode(childrenBySessionId(sessions), sessions[0]);

    expect(collectIds(node)).toEqual(['lane', 'child']);
  });
});
