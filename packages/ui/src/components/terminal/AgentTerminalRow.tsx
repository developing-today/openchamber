import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { openPersistentPtyInput, type PersistentPtyInputChannel } from '@/lib/persistentPtyInput';
import type { TrackedPty } from '@/sync/persistent-ptys';

const SNAPSHOT_REFRESH_MS = 2000;
const SNAPSHOT_AFTER_INPUT_MS = 300;
const NORMAL_CLOSE_CODE = 1000;
const GOING_AWAY_CODE = 1001;

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

export const AgentTerminalRow: React.FC<{ pty: TrackedPty }> = ({ pty }) => {
  const { t } = useI18n();
  const [stopping, setStopping] = React.useState(false);
  const [showing, setShowing] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const label = pty.title || pty.command;

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
      <div className="flex h-10 items-center gap-2 pl-3 pr-1.5">
        <Icon name="terminal-box" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono typography-meta text-foreground" title={pty.command}>
          {label}
        </span>
        <span className="shrink-0 typography-meta text-muted-foreground">
          {pty.status === 'exited' ? t('chat.persistentTerminals.exited') : t('chat.persistentTerminals.running')}
        </span>
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
      {showing ? <TerminalOutput pty={pty} refreshKey={refreshKey} /> : null}
      {showing && pty.status !== 'exited' ? <TerminalInput pty={pty} label={label} onSent={onSent} /> : null}
    </div>
  );
};
