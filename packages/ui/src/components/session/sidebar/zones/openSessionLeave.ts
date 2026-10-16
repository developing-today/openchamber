import type { OpenSessionLeave } from '@/stores/sidebarLayout';
import type { SessionSidebarNavigationEntry } from '../sessionSidebarRowModel';

type LeaveTargetArgs = {
  policy: OpenSessionLeave;
  sessionId: string;
  /** Every session leaving with it (a batch archive), none of which can be the target. */
  leavingIds: ReadonlySet<string>;
  entries: readonly SessionSidebarNavigationEntry[];
  isAttentionContainer: (containerKey: string) => boolean;
  /** A finished turn not looked at yet. */
  isUnread: (sessionId: string) => boolean;
  /** Sessions opened before, newest last. */
  history: readonly string[];
};

/**
 * The session to open once the open one is marked done or archived, from the
 * rows as the user saw them: the top one needing attention (else the first
 * finished one not looked at, else the first in the same list), the next one
 * down or up in the same list (then in the whole sidebar), one direction
 * with the other as fallback when there is nothing that way, or the session
 * opened before. Null when nothing fits or the choice opens nothing.
 */
export const resolveLeaveTarget = (args: LeaveTargetArgs): SessionSidebarNavigationEntry | null => {
  const { policy, sessionId } = args;
  if (policy === 'hold' || policy === 'stay' || policy === 'reveal') return null;
  const seen = new Set<string>();
  const candidates: SessionSidebarNavigationEntry[] = [];
  let position = -1;
  let containerKey: string | null = null;
  for (const entry of args.entries) {
    if (entry.sessionId === sessionId) {
      if (position < 0) {
        position = candidates.length;
        containerKey = entry.containerKey;
      }
      continue;
    }
    if (args.leavingIds.has(entry.sessionId) || seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);
    candidates.push(entry);
  }

  if (policy === 'previous') {
    for (let index = args.history.length - 1; index >= 0; index -= 1) {
      const id = args.history[index];
      const entry = candidates.find((candidate) => candidate.sessionId === id);
      if (entry) return entry;
    }
    return null;
  }
  if (policy === 'attention') {
    return candidates.find((entry) => args.isAttentionContainer(entry.containerKey))
      ?? candidates.find((entry) => args.isUnread(entry.sessionId))
      ?? candidates.find((entry) => entry.containerKey === containerKey)
      ?? null;
  }
  if (position < 0) return null;
  const below = candidates.slice(position);
  const above = candidates.slice(0, position).reverse();
  const inList = (entry: SessionSidebarNavigationEntry): boolean => entry.containerKey === containerKey;
  const down = (): SessionSidebarNavigationEntry | undefined => below.find(inList);
  const up = (): SessionSidebarNavigationEntry | undefined => above.find(inList);
  switch (policy) {
    case 'down': return down() ?? below[0] ?? null;
    case 'up': return up() ?? above[0] ?? null;
    case 'down-up': return down() ?? up() ?? below[0] ?? above[0] ?? null;
    case 'up-down': return up() ?? down() ?? above[0] ?? below[0] ?? null;
  }
};
