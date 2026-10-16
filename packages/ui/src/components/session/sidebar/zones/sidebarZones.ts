import type { Session } from '@/lib/opencode/model';
import {
  attentionZonesInUse,
  otherAttentionZone,
  trackedAttentionZone,
  type SessionAttentionState,
  type SidebarLayout,
  type SidebarZoneKey,
} from '@/stores/sidebarLayout';

/** What the attention zones read about a top-level session and its subsessions. */
export type SessionLiveState = {
  state: SessionAttentionState;
  /** A finished turn the user has not looked at yet. */
  unread: boolean;
};

const IDLE_STATE: SessionLiveState = Object.freeze({ state: 'idle', unread: false });

/** The zones sessions are listed in; Chats and the projects list their sessions themselves. */
export type SidebarSessionZoneKey = Exclude<SidebarZoneKey, 'chats'>;

/** Where the open session is held while it stays open: a zone, or none (its project only). */
export type HeldZonePlacement = { sessionId: string; zone: SidebarSessionZoneKey | null };

export type SidebarZonePartitionArgs = {
  /** Top-level, unarchived sessions in the shared lifecycle order, Chats included. */
  roots: readonly Session[];
  layout: SidebarLayout;
  showPinnedZone: boolean;
  showWorkZone: boolean;
  isPinned: (session: Session) => boolean;
  isInWork: (session: Session) => boolean;
  isChat: (session: Session) => boolean;
  liveStateById: ReadonlyMap<string, SessionLiveState>;
  held: HeldZonePlacement | null;
};

export type SidebarZonePartition = {
  sessionsByZone: ReadonlyMap<SidebarSessionZoneKey, readonly Session[]>;
  /** Every listed session's zone, the held session's included. */
  zoneBySessionId: ReadonlyMap<string, SidebarSessionZoneKey>;
  /** Where each session would be without the hold: the hold compares against it. */
  naturalZoneBySessionId: ReadonlyMap<string, SidebarSessionZoneKey>;
};

/**
 * Sessions the user follows are those the Pinned and In work zones list.
 * Those that need the user (an approval, a question, an error, a stop) or,
 * with "everything not running", every one that is not running, move to the
 * attention zone the layout names for that state. The other sessions, Chats
 * included, join an attention zone only when the layout asks for them, and
 * the active ones get a zone of their own when asked. Every session sits in
 * at most one zone; the zones stay in the lifecycle order of `roots`.
 */
export const partitionSidebarZones = (args: SidebarZonePartitionArgs): SidebarZonePartition => {
  const { layout } = args;
  const usableAttentionZones = attentionZonesInUse(layout);
  const isUsableZone = (zone: SidebarSessionZoneKey): boolean => {
    if (zone === 'pinned') return args.showPinnedZone;
    if (zone === 'work') return args.showWorkZone;
    return usableAttentionZones.has(zone);
  };
  const naturalZone = (session: Session): SidebarSessionZoneKey | null => {
    const live = args.liveStateById.get(session.id) ?? IDLE_STATE;
    if (!args.isChat(session)) {
      const followed: SidebarSessionZoneKey | null = args.showPinnedZone && args.isPinned(session)
        ? 'pinned'
        : args.showWorkZone && args.isInWork(session) ? 'work' : null;
      if (followed) return trackedAttentionZone(layout, live.state) ?? followed;
    }
    const attention = otherAttentionZone(layout, live.state);
    if (attention) return attention;
    if (layout.otherActive && (live.state === 'running' || live.unread)) return 'other-active';
    return null;
  };

  const sessionsByZone = new Map<SidebarSessionZoneKey, Session[]>();
  const zoneBySessionId = new Map<string, SidebarSessionZoneKey>();
  const naturalZoneBySessionId = new Map<string, SidebarSessionZoneKey>();
  for (const session of args.roots) {
    const natural = naturalZone(session);
    if (natural) naturalZoneBySessionId.set(session.id, natural);
    // The held session stays in the zone it was in when the hold began, or
    // out of every zone, as long as that zone is still part of the layout.
    const held = args.held?.sessionId === session.id ? args.held : null;
    const zone = held && (held.zone === null || isUsableZone(held.zone)) ? held.zone : natural;
    if (!zone) continue;
    zoneBySessionId.set(session.id, zone);
    const list = sessionsByZone.get(zone);
    if (list) list.push(session);
    else sessionsByZone.set(zone, [session]);
  }
  return { sessionsByZone, zoneBySessionId, naturalZoneBySessionId };
};

/**
 * The partition again when nothing changed: same zones holding the same
 * sessions in the same order. Session records may have changed underneath;
 * zone items are built from them, so a changed record is a change.
 */
export const reuseUnchangedPartition = (
  previous: SidebarZonePartition | null,
  next: SidebarZonePartition,
): SidebarZonePartition => {
  if (!previous || previous.sessionsByZone.size !== next.sessionsByZone.size) return next;
  for (const [zone, sessions] of next.sessionsByZone) {
    const before = previous.sessionsByZone.get(zone);
    if (!before || before.length !== sessions.length) return next;
    for (let index = 0; index < sessions.length; index += 1) {
      if (before[index] !== sessions[index]) return next;
    }
  }
  if (previous.naturalZoneBySessionId.size !== next.naturalZoneBySessionId.size) return next;
  for (const [id, zone] of next.naturalZoneBySessionId) {
    if (previous.naturalZoneBySessionId.get(id) !== zone) return next;
  }
  return previous;
};
