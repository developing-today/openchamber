import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { blockingRequestLineage, type SessionLookup } from "./scoped-blocking-requests"
import { getAllSyncSessionMap } from "./sync-refs"

/**
 * Where every blocking-request lineage reads session records: the directory
 * stores first, then the global session list. A directory store drops its
 * oldest sessions past its limit, and the global list still holds a parent the
 * store dropped before its subagent asked. Docks and the alerts about a request
 * both use this lookup, so they agree on where the request is answered.
 */
export const sessionRecordLookup = (): SessionLookup => {
  const live = getAllSyncSessionMap()
  const cached = useGlobalSessionsStore.getState().entityById
  return (sessionID) => live.get(sessionID) ?? cached.get(sessionID)
}

/**
 * The session a permission request or form is answered from: the last one in
 * its lineage, the highest session above the one that raised it that still
 * runs in the same directory, whose composer docks it. `directory` is the
 * asking session's own, or null when no record of that session, or no
 * directory on it, is held.
 */
export const resolveBlockingRequestRoot = (sessionID: string) => {
  const lookup = sessionRecordLookup()
  const asking = lookup(sessionID)
  return {
    sessionID: blockingRequestLineage(sessionID, lookup).at(-1) ?? sessionID,
    directory: asking ? resolveGlobalSessionDirectory(asking) : null,
  }
}
