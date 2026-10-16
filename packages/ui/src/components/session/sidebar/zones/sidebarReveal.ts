import { create } from 'zustand';

/**
 * A request to scroll the sidebar to a session's row: after Done with "move
 * and show where it went", the row has left its zone for its project.
 */
type SidebarRevealRequest = { sessionId: string; projectId: string | null; nonce: number };

const useSidebarRevealStore = create<{ request: SidebarRevealRequest | null }>(() => ({ request: null }));

let nonce = 0;

export const requestSidebarReveal = (sessionId: string, projectId: string | null): void => {
  nonce += 1;
  useSidebarRevealStore.setState({ request: { sessionId, projectId, nonce } });
};

export const useSidebarRevealRequest = (): SidebarRevealRequest | null => useSidebarRevealStore((state) => state.request);

/** Drops the request once it was served, unless a newer one replaced it. */
export const settleSidebarReveal = (request: SidebarRevealRequest): void => {
  if (useSidebarRevealStore.getState().request === request) useSidebarRevealStore.setState({ request: null });
};
