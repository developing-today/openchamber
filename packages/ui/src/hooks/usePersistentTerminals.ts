import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { opencodeClient } from '@/lib/opencode/client';
import { replaceSessionTerminals, usePersistentPtysStore, type TrackedPty } from '@/sync/persistent-ptys';

export const useSessionTerminals = (sessionId: string): TrackedPty[] => usePersistentPtysStore(useShallow((state) => (
  [...state.byId.values()].filter((pty) => pty.sessionID === sessionId)
)));

export const useHasSessionTerminals = (sessionId: string | null): boolean => usePersistentPtysStore((state) => (
  sessionId !== null && [...state.byId.values()].some((pty) => pty.sessionID === sessionId)
));

/** Reads the session's terminals when it is shown; events keep them current after that. */
export const useSessionTerminalsLoaded = (sessionId: string | null, directory: string | undefined): void => {
  React.useEffect(() => {
    if (!sessionId || !directory) return;
    let active = true;
    opencodeClient.listSessionTerminals(sessionId, directory)
      .then((listed) => { if (active) replaceSessionTerminals(sessionId, directory, listed); })
      .catch((error) => console.warn('[terminals] list failed', error));
    return () => { active = false; };
  }, [sessionId, directory]);
};
