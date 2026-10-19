import type { Session } from '@/lib/opencode/model';

import { getParentId } from './mobileSessionFields';

export type MobileSessionTree = {
  childrenByParent: Map<string, Session[]>;
  roots: Session[];
};

/** Groups one bucket's sessions into the tree the mobile sheet renders.
    Sessions whose parent sits outside the bucket count as roots, so an
    orphan still shows. A parent cycle has no root at all, so after the
    normal roots claim their descendants, each session nobody claimed
    becomes a root itself, in input order. Every session in the bucket
    ends up reachable from exactly one root. The children map holds only
    edges the render walk can follow: an edge back to a session already
    claimed earlier in the walk is dropped, so the closing node of a
    cycle and a self-parented session report no children. Callers still
    guard their rendering walk with a visited set as a backstop. */
export const buildMobileSessionTree = (sessions: readonly Session[]): MobileSessionTree => {
  const idsInBucket = new Set(sessions.map((entry) => entry.id));
  const childrenByParent = new Map<string, Session[]>();
  for (const candidate of sessions) {
    const parentId = getParentId(candidate);
    if (parentId && idsInBucket.has(parentId)) {
      const list = childrenByParent.get(parentId) ?? [];
      list.push(candidate);
      childrenByParent.set(parentId, list);
    }
  }

  const claimed = new Set<string>();
  const claimFrom = (root: Session): void => {
    const pending = [root];
    while (pending.length > 0) {
      const next = pending.pop();
      if (!next || claimed.has(next.id)) continue;
      claimed.add(next.id);
      for (const child of childrenByParent.get(next.id) ?? []) {
        pending.push(child);
      }
    }
  };

  const roots: Session[] = [];
  for (const entry of sessions) {
    const parentId = getParentId(entry);
    if (!parentId || !idsInBucket.has(parentId)) {
      roots.push(entry);
      claimFrom(entry);
    }
  }
  for (const entry of sessions) {
    if (claimed.has(entry.id)) continue;
    roots.push(entry);
    claimFrom(entry);
  }

  const renderableChildrenByParent = new Map<string, Session[]>();
  const walked = new Set<string>();
  const pruneFrom = (entry: Session): void => {
    if (walked.has(entry.id)) return;
    walked.add(entry.id);
    const kept: Session[] = [];
    for (const child of childrenByParent.get(entry.id) ?? []) {
      if (walked.has(child.id)) continue;
      kept.push(child);
      pruneFrom(child);
    }
    if (kept.length > 0) {
      renderableChildrenByParent.set(entry.id, kept);
    }
  };
  for (const root of roots) {
    pruneFrom(root);
  }

  return { childrenByParent: renderableChildrenByParent, roots };
};
