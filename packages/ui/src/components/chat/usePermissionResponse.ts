import React from 'react';
import type { PermissionReply, PermissionRequest } from '@/types/permission';
import { useChatColumnActions, useChatSessionSelection } from './chatColumnSession';
import { useSessions } from '@/sync/sync-context';
import { isSubagentRequest } from '@/sync/scoped-blocking-requests';
import * as sessionActions from '@/sync/session-actions';
import { canSavePermission } from './permissionSummary';

type ColumnKind = 'main' | 'pinned';

// Newest pending card of a chat owns that chat's keyboard; older cards wait
// their turn. With a chat pinned in the side panel, each chat answers only the
// keys pressed inside it (anywhere else counts as the main chat).
const activePermissionCards: Array<{ id: string; column: ColumnKind }> = [];

const columnOfEvent = (event: KeyboardEvent): ColumnKind => (
  event.target instanceof Element && event.target.closest('[data-chat-column="pinned"]') ? 'pinned' : 'main'
);

/**
 * The reply a key press gives: Alt+Enter allows once, Alt+Shift+Enter always
 * (only when the request has something to save), Alt+Backspace denies.
 */
export const permissionShortcutReply = (
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey'>,
  canSave: boolean,
): PermissionReply | null => {
  if (!event.altKey || event.metaKey || event.ctrlKey) return null;
  if (event.key === 'Enter') return event.shiftKey ? (canSave ? 'always' : null) : 'once';
  if (event.key === 'Backspace' && !event.shiftKey) return 'reject';
  return null;
};

/** The message a deny-with-feedback reply carries; blank text is no message. */
export const permissionFeedbackMessage = (text: string): string | undefined => {
  const trimmed = text.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * What a key press in the deny-feedback box means. Enter submits on desktop
 * and Shift+Enter inserts a newline; on mobile Enter inserts a newline and
 * only Cmd/Ctrl+Enter submits (the FormDock rule). Escape cancels back to the
 * buttons. IME composition never submits or cancels (mirrors
 * `isIMECompositionEvent` in lib/ime).
 */
export const permissionFeedbackKeyAction = (
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'isComposing' | 'keyCode'>,
  isMobile: boolean,
): 'submit' | 'cancel' | null => {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.key === 'Escape') return 'cancel';
  if (event.key !== 'Enter' || event.shiftKey) return null;
  if (event.ctrlKey || event.metaKey) return 'submit';
  return isMobile ? null : 'submit';
};

/** The request was raised by a subagent below the session the user is looking at, at any depth. */
export const usePermissionFromSubagent = (permission: PermissionRequest): boolean => {
  const { sessionId: currentSessionId, directory: currentSessionDirectory } = useChatSessionSelection();
  const sessions = useSessions(currentSessionDirectory ?? undefined);
  return React.useMemo(
    () => isSubagentRequest(sessions, permission.sessionID, currentSessionId),
    [permission.sessionID, currentSessionId, sessions],
  );
};

/**
 * Replies to one request and owns its keyboard shortcuts while it is the
 * newest pending one (see `permissionShortcutReply`). Shared by the inline
 * card and the dock.
 */
export const usePermissionResponse = (
  permission: PermissionRequest,
  onResponse?: (response: PermissionReply) => void,
) => {
  const column: ColumnKind = useChatColumnActions().pinned ? 'pinned' : 'main';
  const [isResponding, setIsResponding] = React.useState(false);
  const [hasResponded, setHasResponded] = React.useState(false);
  const respondToPermission = sessionActions.respondToPermission;
  const canSave = canSavePermission(permission.save);

  const respond = React.useCallback(async (response: PermissionReply, message?: string) => {
    setIsResponding(true);
    try {
      await respondToPermission(permission.sessionID, permission.id, response, undefined, message);
      setHasResponded(true);
      onResponse?.(response);
    } catch (error) {
      console.error('[PermissionCard] Failed to respond to permission:', error);
    } finally {
      setIsResponding(false);
    }
  }, [onResponse, permission.id, permission.sessionID, respondToPermission]);

  const respondRef = React.useRef(respond);
  respondRef.current = respond;

  React.useEffect(() => {
    if (hasResponded) return;
    const card = { id: permission.id, column };
    activePermissionCards.push(card);
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = columnOfEvent(event);
      let owner: typeof card | undefined;
      for (const entry of activePermissionCards) {
        if (entry.column === target) owner = entry;
      }
      if (owner !== card) return;
      const response = permissionShortcutReply(event, canSave);
      if (!response) return;
      event.preventDefault();
      event.stopPropagation();
      void respondRef.current(response);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      const index = activePermissionCards.lastIndexOf(card);
      if (index !== -1) activePermissionCards.splice(index, 1);
    };
  }, [canSave, column, hasResponded, permission.id]);

  return { isResponding, hasResponded, respond };
};
