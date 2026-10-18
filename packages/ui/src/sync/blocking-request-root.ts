import type { Session } from "@/lib/opencode/model"
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getAllSyncSessionMap } from "./sync-refs"

/**
 * The session a permission request or form is answered from: the highest
 * session above the one that raised it that still runs in the same directory.
 * Its composer docks every request raised below it from that directory's
 * store. A subagent moved to another directory takes its requests to that
 * directory's store, which no dock above the move reads, so the walk stops
 * before an ancestor in another directory. It climbs only through sessions
 * this client holds a record for; `directory` is the asking session's own, or
 * null when no record of that session, or no directory on it, is held.
 */
export const resolveBlockingRequestRoot = (sessionID: string) => {
  const live = getAllSyncSessionMap()
  const cached = useGlobalSessionsStore.getState().entityById
  const recordOf = (id: string | undefined): Session | undefined => (id ? live.get(id) ?? cached.get(id) : undefined)
  const asking = recordOf(sessionID)
  const directory = asking ? resolveGlobalSessionDirectory(asking) : null
  if (!asking || directory === null) return { sessionID, directory }
  let root = asking
  const seen = new Set([asking.id])
  for (
    let parent = recordOf(asking.parentID);
    parent && !seen.has(parent.id) && resolveGlobalSessionDirectory(parent) === directory;
    parent = recordOf(parent.parentID)
  ) {
    seen.add(parent.id)
    root = parent
  }
  return { sessionID: root.id, directory }
}
