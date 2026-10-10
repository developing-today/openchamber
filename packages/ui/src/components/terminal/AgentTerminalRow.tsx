import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { openPersistentPtyInput, type PersistentPtyInputChannel } from '@/lib/persistentPtyInput';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import type { TrackedPty } from '@/sync/persistent-ptys';

const SNAPSHOT_REFRESH_MS = 2000;
const SNAPSHOT_AFTER_INPUT_MS = 300;
const NORMAL_CLOSE_CODE = 1000;
const GOING_AWAY_CODE = 1001;

const commandLine = (pty: TrackedPty): string => [pty.command, ...pty.args].join(' ');

const TerminalOutput: React.FC<{ pty: TrackedPty; refreshKey: number }> = ({ pty, refreshKey }) => {
  const { t } = useI18n();
  const [text, setText] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    const read = () => {
      opencodeClient.readTerminalSnapshot(pty.id, pty.directory)
        .then((snapshot) => { if (active) setText(snapshot.text); })
        .catch(() => { if (active) setText(null); });
    };
    read();
    const timer = window.setInterval(read, SNAPSHOT_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [pty.id, pty.directory, refreshKey]);

  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono typography-meta text-muted-foreground">
      {text ?? t('chat.persistentTerminals.noOutput')}
    </pre>
  );
};

/**
 * Types a line into the terminal. The controller attachment is opened on the first
 * send and closed when this unmounts, so an idle terminal is not held.
 */
const TerminalInput: React.FC<{ pty: TrackedPty; label: string; onSent: () => void }> = ({ pty, label, onSent }) => {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState('');
  const channelRef = React.useRef<PersistentPtyInputChannel | null>(null);

  React.useEffect(() => () => {
    const channel = channelRef.current;
    channelRef.current = null;
    channel?.close();
  }, []);

  const submit = () => {
    let channel = channelRef.current;
    if (!channel?.isOpen) {
      const opened: PersistentPtyInputChannel = openPersistentPtyInput({
        ptyID: pty.id,
        directory: pty.directory,
        size: pty.size,
        onClose: (code) => {
          if (channelRef.current !== opened) return;
          channelRef.current = null;
          if (code !== NORMAL_CLOSE_CODE && code !== GOING_AWAY_CODE) toast.error(t('chat.persistentTerminals.inputFailed'));
        },
      });
      channel = opened;
      channelRef.current = opened;
    }
    channel.send(`${draft}\r`);
    setDraft('');
    onSent();
  };

  return (
    <div className="flex items-center gap-2 px-3 pb-2">
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          submit();
        }}
        placeholder={t('chat.persistentTerminals.inputPlaceholder')}
        aria-label={t('chat.persistentTerminals.inputAria', { command: label })}
        className="h-8 min-w-0 flex-1 font-mono typography-meta"
      />
      <Button type="button" variant="ghost" size="sm" onClick={submit} className="shrink-0">
        {t('chat.persistentTerminals.send')}
      </Button>
    </div>
  );
};

const TerminalRename: React.FC<{ ptyID: string; command: string; initial: string; onDone: () => void }> = ({ ptyID, command, initial, onDone }) => {
  const { t } = useI18n();
  const setName = useUIStore((state) => state.setAgentTerminalName);
  const [draft, setDraft] = React.useState(initial);
  const cancelledRef = React.useRef(false);

  const finish = () => {
    if (!cancelledRef.current) setName(ptyID, draft);
    onDone();
  };

  return (
    <Input
      autoFocus
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          finish();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelledRef.current = true;
          onDone();
        }
      }}
      onBlur={finish}
      placeholder={t('chat.persistentTerminals.renamePlaceholder', { command })}
      aria-label={t('chat.persistentTerminals.renameAria', { command })}
      className="h-7 min-w-0 flex-1 font-mono typography-meta"
    />
  );
};

export const AgentTerminalRow: React.FC<{ pty: TrackedPty }> = ({ pty }) => {
  const { t } = useI18n();
  const [stopping, setStopping] = React.useState(false);
  const [showing, setShowing] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const customName = useUIStore((state) => state.agentTerminalNames[pty.id]);
  const origin = useSession(pty.sessionID, pty.directory);
  const command = commandLine(pty);
  const label = customName ?? command;
  const isSubagent = Boolean(origin?.parentID);
  const originTitle = origin?.title || pty.sessionID;

  const onSent = React.useCallback(() => {
    window.setTimeout(() => setRefreshKey((value) => value + 1), SNAPSHOT_AFTER_INPUT_MS);
  }, []);

  const stop = () => {
    if (stopping) return;
    setStopping(true);
    opencodeClient.removeTerminal(pty.id, pty.directory).catch(() => {
      setStopping(false);
      toast.error(t('chat.persistentTerminals.stopFailed'));
    });
  };

  return (
    <div>
      <div className="flex h-8 items-center gap-2 pl-3 pr-1.5 pt-1">
        <Icon name="terminal-box" className="size-3.5 shrink-0 text-muted-foreground" />
        {renaming ? (
          <TerminalRename ptyID={pty.id} command={command} initial={customName ?? ''} onDone={() => setRenaming(false)} />
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono typography-meta text-foreground" title={`${command} (${pty.id})`}>
            {label}
            {customName ? null : <span className="text-muted-foreground"> …{pty.id.slice(-6)}</span>}
          </span>
        )}
        {renaming ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRenaming(true)}
            onMouseDown={(event) => event.preventDefault()}
            aria-label={t('chat.persistentTerminals.rename')}
            title={t('chat.persistentTerminals.rename')}
            className="shrink-0 px-1.5"
          >
            <Icon name="pencil" className="size-3.5" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowing((value) => !value)}
          onMouseDown={(event) => event.preventDefault()}
          aria-expanded={showing}
          className="shrink-0"
        >
          {showing ? t('chat.persistentTerminals.hide') : t('chat.persistentTerminals.show')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={stopping}
          onClick={stop}
          onMouseDown={(event) => event.preventDefault()}
          aria-label={t('chat.persistentTerminals.stopAria', { command: label })}
          className="shrink-0 text-status-error/80 hover:bg-transparent hover:text-status-error"
        >
          {t('chat.persistentTerminals.stop')}
        </Button>
      </div>
      <div className="flex items-center gap-2 pb-1 pl-7 pr-1.5">
        <button
          type="button"
          onClick={() => useSessionUIStore.getState().setCurrentSession(pty.sessionID, pty.directory)}
          title={pty.sessionID}
          className="min-w-0 flex-1 truncate text-left typography-meta text-muted-foreground hover:text-foreground"
        >
          {t(isSubagent ? 'chat.persistentTerminals.originSubagent' : 'chat.persistentTerminals.origin', { title: originTitle })}
        </button>
        <span className="shrink-0 typography-meta text-muted-foreground">
          {pty.status === 'exited' ? t('chat.persistentTerminals.exited') : t('chat.persistentTerminals.running')}
        </span>
      </div>
      {showing ? <TerminalOutput pty={pty} refreshKey={refreshKey} /> : null}
      {showing && pty.status !== 'exited' ? <TerminalInput pty={pty} label={label} onSent={onSent} /> : null}
    </div>
  );
};
