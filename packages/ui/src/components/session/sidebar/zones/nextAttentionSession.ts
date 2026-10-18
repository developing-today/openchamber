import type { SessionSidebarNavigationEntry } from '../sessionSidebarRowModel';

/**
 * The next session that needs attention, for the keyboard shortcut: the first
 * attention-section entry in the order the sidebar draws them, after the one
 * open now, wrapping around at the end. A session drawn twice (its zone and
 * its project) counts once, at its first place. When the open session is not
 * itself in an attention section — or none is open — the first attention
 * entry wins. Null when nothing needs attention.
 */
export const resolveNextAttentionEntry = (
  entries: readonly SessionSidebarNavigationEntry[],
  currentSessionId: string | null,
  isAttentionContainer: (containerKey: string) => boolean,
): SessionSidebarNavigationEntry | null => {
  const seen = new Set<string>();
  const attention: SessionSidebarNavigationEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.sessionId)) continue;
    seen.add(entry.sessionId);
    if (isAttentionContainer(entry.containerKey)) attention.push(entry);
  }
  if (attention.length === 0) return null;
  const currentIndex = currentSessionId === null
    ? -1
    : attention.findIndex((entry) => entry.sessionId === currentSessionId);
  if (currentIndex < 0) return attention[0];
  // The open session is the only one needing attention: opening it again
  // would go nowhere, so there is nothing to move to.
  if (attention.length === 1) return null;
  return attention[(currentIndex + 1) % attention.length];
};
