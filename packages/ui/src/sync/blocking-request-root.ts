import type { Session } from "@/lib/opencode/model"
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { getAllSyncSessionMap } from "./sync-refs"

/**
 * The session a permission request or form is answered from: the top-level
 * session above the one that raised it. That session's composer docks every
 * request raised anywhere in its tree, so each alert about one opens it there.
 * The walk climbs through the sessions this client holds a record for and
 * stops at the highest of them; `directory` is that session's own, or null
 * when it holds no record of the session that asked either.
 */
export const resolveBlockingRequestRoot = (sessionID: string) => {
  const live = getAllSyncSessionMap()
  const cached = useGlobalSessionsStore.getState().entityById
  const recordOf = (id: string | undefined): Session | undefined => (id ? live.get(id) ?? cached.get(id) : undefined)
  let root = recordOf(sessionID)
  if (!root) return { sessionID, directory: null }
  const seen = new Set([root.id])
  for (let parent = recordOf(root.parentID); parent && !seen.has(parent.id); parent = recordOf(parent.parentID)) {
    seen.add(parent.id)
    root = parent
  }
  return { sessionID: root.id, directory: resolveGlobalSessionDirectory(root) }
}
