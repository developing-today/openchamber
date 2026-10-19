import type { SessionNode } from '@/components/session/sidebar/types';
import type { Session } from '@/lib/opencode/model';

/** Builds one multi-run lane's session tree for the mobile sheet.
    The children map is the raw parent→children map over every session,
    so a lane that is self-parented or sits in a parent cycle would
    recurse forever without a guard. A visited set seeded with the
    lane's own id drops any edge back to a session already placed in
    this lane's tree, the same treatment buildActiveSessionNode gives
    the desktop sidebar's lanes: each session appears at most once per
    lane tree, and acyclic trees are unchanged. */
export const buildRunLaneNode = (
  childrenBySessionId: ReadonlyMap<string, readonly Session[]>,
  session: Session,
): SessionNode => {
  const visited = new Set<string>([session.id]);
  const build = (current: Session): SessionNode => ({
    session: current,
    children: (childrenBySessionId.get(current.id) ?? []).flatMap((child) => {
      if (visited.has(child.id)) return [];
      visited.add(child.id);
      return [build(child)];
    }),
    worktree: null,
  });
  return build(session);
};
