import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';

import { buildMobileSessionTree, type MobileSessionTree } from './mobileSessionTree';

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

/** Walks the tree the way the sheet's renderNode does, with a visited set
    so a cycle terminates. Returns ids in render order. */
const collectRenderedIds = (tree: MobileSessionTree): string[] => {
  const rendered = new Set<string>();
  const ids: string[] = [];
  const visit = (entry: Session): void => {
    if (rendered.has(entry.id)) return;
    rendered.add(entry.id);
    ids.push(entry.id);
    for (const child of tree.childrenByParent.get(entry.id) ?? []) {
      visit(child);
    }
  };
  for (const root of tree.roots) visit(root);
  return ids;
};

describe('buildMobileSessionTree', () => {
  test('renders every session in a parent cycle exactly once', () => {
    const tree = buildMobileSessionTree([
      session('root'),
      session('child', 'root'),
      session('a', 'b'),
      session('b', 'a'),
      session('self', 'self'),
      session('orphan', 'missing'),
    ]);

    expect(tree.roots.map((entry) => entry.id)).toEqual(['root', 'orphan', 'a', 'self']);
    expect(collectRenderedIds(tree)).toEqual(['root', 'child', 'orphan', 'a', 'b', 'self']);
  });

  test('keeps acyclic buckets unchanged', () => {
    const tree = buildMobileSessionTree([
      session('root'),
      session('child', 'root'),
      session('grandchild', 'child'),
      session('orphan', 'missing'),
      session('other'),
    ]);

    expect(tree.roots.map((entry) => entry.id)).toEqual(['root', 'orphan', 'other']);
    expect(collectRenderedIds(tree)).toEqual(['root', 'child', 'grandchild', 'orphan', 'other']);
  });

  test('exposes each separate cycle component once, in input order', () => {
    const tree = buildMobileSessionTree([
      session('x', 'y'),
      session('y', 'x'),
      session('p', 'q'),
      session('q', 'p'),
    ]);

    expect(tree.roots.map((entry) => entry.id)).toEqual(['x', 'p']);
    expect(collectRenderedIds(tree)).toEqual(['x', 'y', 'p', 'q']);
  });

  test('handles an empty bucket', () => {
    const tree = buildMobileSessionTree([]);

    expect(tree.roots).toEqual([]);
    expect(collectRenderedIds(tree)).toEqual([]);
  });
});
