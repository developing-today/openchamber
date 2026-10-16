import React from 'react';
import { create } from 'zustand';
import type { Session } from '@/lib/opencode/model';
import { isSessionPinned } from '@/lib/sessionPins';
import { getSessionLifecycleOrderValue, useSessionOrderingStore } from '@/sync/session-ordering';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { SidebarSessionZoneKey } from './sidebarZones';

/**
 * Where the open session was when the hold began: the zone it was listed in
 * (or none) and its place in the lifecycle order. `done` holds exist only for
 * the "keep the row until I leave" choice after Done, without the general hold.
 */
type HeldPlacement = { sessionId: string; zone: SidebarSessionZoneKey | null; rank: number; reason: 'open' | 'done' };

/**
 * What the sidebar draws differently from the live order for the open
 * session: its zone and its rank, each only while it differs from where the
 * session would be now. Null while nothing differs, so the sidebar re-renders
 * only when the open session's place has actually moved under it.
 */
type OpenSessionOverride = {
  sessionId: string;
  /** Present while the held zone differs from the live one; null holds it out of every zone. */
  zone?: SidebarSessionZoneKey | null;
  rank?: number;
};

type OpenSessionHoldState = {
  held: HeldPlacement | null;
  /** Let go by the user (Done, "move at once"): not held again until another session opens. */
  releasedSessionId: string | null;
  /** Sessions opened before, newest last, for "back to the previous session". */
  history: readonly string[];
  override: OpenSessionOverride | null;
};

const HISTORY_LIMIT = 20;

const useOpenSessionHoldStore = create<OpenSessionHoldState>(() => ({
  held: null,
  releasedSessionId: null,
  history: [],
  override: null,
}));

type HoldInputs = {
  enabled: boolean;
  sessionById: ReadonlyMap<string, Session>;
  naturalZoneBySessionId: ReadonlyMap<string, SidebarSessionZoneKey>;
  pinnedSessionIds: Set<string>;
};

let inputs: HoldInputs | null = null;

const lifecycleValue = (session: Session, pinnedSessionIds: Set<string>): number => getSessionLifecycleOrderValue(
  session,
  useSessionOrderingStore.getState().rankById,
  isSessionPinned(pinnedSessionIds, session.directory, session.id),
);

const placementOf = (sessionId: string, reason: HeldPlacement['reason']): HeldPlacement | null => {
  const session = inputs?.sessionById.get(sessionId);
  if (!inputs || !session) return null;
  return {
    sessionId,
    zone: inputs.naturalZoneBySessionId.get(sessionId) ?? null,
    rank: lifecycleValue(session, inputs.pinnedSessionIds),
    reason,
  };
};

const sameOverride = (left: OpenSessionOverride | null, right: OpenSessionOverride | null): boolean => (
  left === right || (left !== null && right !== null
    && left.sessionId === right.sessionId && left.zone === right.zone && left.rank === right.rank)
);

/** Brings the held placement and the published override in line with the live state. */
const reconcile = (): void => {
  const state = useOpenSessionHoldStore.getState();
  const currentId = useSessionUIStore.getState().currentSessionId;
  let held = state.held;
  if (held && (held.sessionId !== currentId || (held.reason === 'open' && !inputs?.enabled))) held = null;
  if (!held && inputs?.enabled && currentId && currentId !== state.releasedSessionId) {
    held = placementOf(currentId, 'open');
  }
  let override: OpenSessionOverride | null = null;
  const session = held ? inputs?.sessionById.get(held.sessionId) : undefined;
  if (held && session && inputs) {
    const liveZone = inputs.naturalZoneBySessionId.get(held.sessionId) ?? null;
    const liveRank = lifecycleValue(session, inputs.pinnedSessionIds);
    if (held.zone !== liveZone || held.rank !== liveRank) {
      override = { sessionId: held.sessionId };
      if (held.zone !== liveZone) override.zone = held.zone;
      if (held.rank !== liveRank) override.rank = held.rank;
    }
  }
  if (held === state.held && sameOverride(override, state.override)) return;
  useOpenSessionHoldStore.setState({
    held,
    override: sameOverride(override, state.override) ? state.override : override,
  });
};

const handleOpenedSession = (sessionId: string | null): void => {
  const { history } = useOpenSessionHoldStore.getState();
  const nextHistory = sessionId && history[history.length - 1] !== sessionId
    ? [...history.filter((id) => id !== sessionId), sessionId].slice(-HISTORY_LIMIT)
    : history;
  useOpenSessionHoldStore.setState({ held: null, releasedSessionId: null, history: nextHistory });
  reconcile();
};

/** What the sidebar must draw differently for the open session; read before the collection is ordered. */
export const useOpenSessionOverride = (): OpenSessionOverride | null => useOpenSessionHoldStore((state) => state.override);

/**
 * Keeps the open session where it was while it stays open: everything
 * underneath (zone membership, the live order) moves as usual, and the
 * session takes its live place as soon as another session opens.
 * Selection is followed with a store subscription, so opening a session does
 * not re-render the sidebar unless its drawn place changes.
 */
export const useOpenSessionHoldTracking = (next: HoldInputs): void => {
  React.useLayoutEffect(() => {
    inputs = next;
    reconcile();
  }, [next]);
  React.useEffect(() => {
    let previous = useSessionUIStore.getState().currentSessionId;
    handleOpenedSession(previous);
    const releaseSelection = useSessionUIStore.subscribe((state) => {
      if (state.currentSessionId === previous) return;
      previous = state.currentSessionId;
      handleOpenedSession(previous);
    });
    const releaseRanks = useSessionOrderingStore.subscribe((state, before) => {
      if (state.rankById !== before.rankById) reconcile();
    });
    return () => {
      releaseSelection();
      releaseRanks();
      inputs = null;
      useOpenSessionHoldStore.setState({ held: null, releasedSessionId: null, override: null });
    };
  }, []);
};

/** Holds the open session where it is now, for "keep the row until I leave" after Done. */
export const holdOpenSessionForDone = (sessionId: string): void => {
  const { held } = useOpenSessionHoldStore.getState();
  if (held?.sessionId === sessionId) return;
  const placement = placementOf(sessionId, 'done');
  if (!placement) return;
  useOpenSessionHoldStore.setState({ held: placement });
  reconcile();
};

/** Lets the open session move at once; the returned function holds it again. */
export const releaseOpenSession = (sessionId: string): (() => void) => {
  const before = useOpenSessionHoldStore.getState();
  useOpenSessionHoldStore.setState({
    held: before.held?.sessionId === sessionId ? null : before.held,
    releasedSessionId: sessionId,
  });
  reconcile();
  return () => {
    if (useOpenSessionHoldStore.getState().releasedSessionId !== sessionId) return;
    useOpenSessionHoldStore.setState({ releasedSessionId: null, held: before.held });
    reconcile();
  };
};

/** Sessions opened before the current one, newest last. */
export const getOpenedSessionHistory = (): readonly string[] => useOpenSessionHoldStore.getState().history;
