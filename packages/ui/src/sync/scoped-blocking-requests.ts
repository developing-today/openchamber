import type { Session } from "@/lib/opencode/model"
import { resolveGlobalSessionDirectory } from "@/stores/globalSessionStructure"

type BlockingRequest = { id: string }

/** The record of a session, or nothing when none is held. */
export type SessionLookup = (sessionID: string) => Session | undefined

export const computeSubtreeIds = (sessions: Session[], rootId: string): Set<string> => {
  const childrenByParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const list = childrenByParent.get(session.parentID) ?? []
    list.push(session.id)
    childrenByParent.set(session.parentID, list)
  }

  const ids = new Set<string>([rootId])
  const queue = [rootId]
  for (const id of queue) {
    const children = childrenByParent.get(id)
    if (!children) continue
    for (const childId of children) {
      if (ids.has(childId)) continue
      ids.add(childId)
      queue.push(childId)
    }
  }
  return ids
}

/**
 * The sessions whose composer docks a permission request or form raised in
 * `sessionID`: that session, then each ancestor above it that runs in the same
 * directory, nearest first. A subagent moved to another directory takes its
 * requests to that directory's store, which no dock above the move reads, so
 * the walk stops before an ancestor in another directory. It also stops at a
 * parent `lookup` holds no record of. Docks and the alerts about a request
 * both read this one lineage, so an alert opens a session whose dock shows
 * the request.
 */
export const blockingRequestLineage = (sessionID: string, lookup: SessionLookup): string[] => {
  const lineage = [sessionID]
  const asking = lookup(sessionID)
  const directory = asking ? resolveGlobalSessionDirectory(asking) : null
  if (!asking || directory === null) return lineage
  for (
    let parent = asking.parentID ? lookup(asking.parentID) : undefined;
    parent && !lineage.includes(parent.id) && resolveGlobalSessionDirectory(parent) === directory;
    parent = parent.parentID ? lookup(parent.parentID) : undefined
  ) {
    lineage.push(parent.id)
  }
  return lineage
}

/** The request comes from a subagent below the viewed session, at any depth. */
export const isSubagentRequest = (requestSessionId: string, viewedSessionId: string | null, lookup: SessionLookup): boolean => {
  if (!viewedSessionId || requestSessionId === viewedSessionId) return false
  return blockingRequestLineage(requestSessionId, lookup).includes(viewedSessionId)
}

export const areRequestArraysReferentiallyEqual = <T extends BlockingRequest>(left: T[], right: T[]): boolean => {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * The requests the composer of `sessionID` docks: each one whose lineage
 * reaches that session, its own first and a nearer subagent's before a farther
 * one's.
 */
export const collectScopedBlockingRequests = <T extends BlockingRequest>(
  requestsBySession: Record<string, T[] | undefined>,
  sessionID: string | null,
  lookup: SessionLookup,
  empty: T[],
): T[] => {
  if (!sessionID) return empty

  const docked = Object.entries(requestsBySession)
    .flatMap(([requestSessionID, entries]) => {
      if (!entries?.length) return []
      const distance = blockingRequestLineage(requestSessionID, lookup).indexOf(sessionID)
      return distance < 0 ? [] : [{ distance, entries }]
    })
    .sort((left, right) => left.distance - right.distance)

  const seen = new Set<string>()
  const result: T[] = []
  for (const { entries } of docked) {
    for (const entry of entries) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      result.push(entry)
    }
  }

  return result.length === 0 ? empty : result
}
