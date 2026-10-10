import React from 'react';
import { useSessionTerminals, useSessionTerminalsLoaded } from '@/hooks/usePersistentTerminals';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionDirectory, useSyncDirectory } from '@/sync/sync-context';
import { AgentTerminalRow } from './AgentTerminalRow';

/** The current session's terminals the agent started, one row each. Renders nothing when there are none. */
export const AgentTerminalsSection: React.FC = () => {
  const { t } = useI18n();
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessionDirectory = useSessionDirectory(sessionId);
  const syncDirectory = useSyncDirectory();
  useSessionTerminalsLoaded(sessionId, sessionDirectory ?? syncDirectory);
  const terminals = useSessionTerminals(sessionId ?? '');
  if (!sessionId || terminals.length === 0) return null;
  return (
    <div role="group" aria-label={t('chat.persistentTerminals.aria')} className="shrink-0 border-b border-border/60">
      {terminals.map((pty) => (
        <AgentTerminalRow key={pty.id} pty={pty} />
      ))}
    </div>
  );
};
