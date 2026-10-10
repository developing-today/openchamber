import { create } from 'zustand';
import type { PersistentPtyInfo } from '@opencode/client';
import type { SyncEvent } from '@/lib/opencode/events';

// Terminals an agent started with the pty tool, by id. `persistent-pty.added`
// and `persistent-pty.removed` keep the index current; a session's list is read
// when its composer shows, and replaces only that session's terminals.

export type TrackedPty = PersistentPtyInfo & { directory: string };

type PersistentPtysState = {
  byId: ReadonlyMap<string, TrackedPty>;
};

export const usePersistentPtysStore = create<PersistentPtysState>(() => ({
  byId: new Map(),
}));

export const applyPersistentPtyEvents = (directory: string, events: readonly SyncEvent[]): void => {
  if (!events.some((event) => event.type === 'persistent-pty.added' || event.type === 'persistent-pty.removed')) return;
  const next = new Map(usePersistentPtysStore.getState().byId);
  for (const event of events) {
    if (event.type === 'persistent-pty.added') {
      next.set(event.properties.terminal.id, { ...event.properties.terminal, directory });
    } else if (event.type === 'persistent-pty.removed') {
      next.delete(event.properties.ptyID);
    }
  }
  usePersistentPtysStore.setState({ byId: next });
};

export const replaceSessionTerminals = (
  sessionID: string,
  directory: string,
  terminals: readonly PersistentPtyInfo[],
): void => {
  const next = new Map<string, TrackedPty>();
  for (const pty of usePersistentPtysStore.getState().byId.values()) {
    if (pty.sessionID !== sessionID) next.set(pty.id, pty);
  }
  for (const terminal of terminals) next.set(terminal.id, { ...terminal, directory });
  usePersistentPtysStore.setState({ byId: next });
};
