import React from 'react';
import { useSessionTerminals } from '@/hooks/usePersistentTerminals';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { AgentTerminalRow } from './AgentTerminalRow';

/** The current session's terminals the agent started, one row each. Renders nothing when there are none. */
export const AgentTerminalsSection: React.FC = () => {
  const { t } = useI18n();
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
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
