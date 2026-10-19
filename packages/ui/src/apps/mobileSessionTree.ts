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
    ends up reachable from exactly one root. Callers still guard their
    rendering walk with a visited set, because a cycle root's children
    lead back to the root. */
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

  return { childrenByParent, roots };
};
