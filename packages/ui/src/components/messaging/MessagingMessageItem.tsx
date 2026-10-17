import React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { KnowledgeMenu } from '@/components/session/project-context/KnowledgeActions';
import { useI18n } from '@/lib/i18n';
import type { MessagingMessage, MessagingOp } from '@/lib/opencode/messaging';
import { cn } from '@/lib/utils';
import { useMessagingStore } from '@/stores/useMessagingStore';
import { MessagingStatusLine } from './MessagingStatusLine';
import { useMessageTime, useTopicLabel, useWriterName } from './messagingLabels';

/** Bodies longer than this start folded. */
const FOLD_CHARACTERS = 600;
const FOLD_LINES = 8;

type HistoryState =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'ready'; ops: MessagingOp[] }
  | { kind: 'failed'; error: string };

const OpLine: React.FC<{ op: MessagingOp }> = ({ op }) => {
  const { t } = useI18n();
  const writer = useWriterName(op.writer);
  const time = useMessageTime();
  const everyone = op.viewers.includes('*');
  const viewers = op.viewers.join(', ');
  const text = op.kind === 'restore'
    ? everyone ? t('messaging.message.historyRestoreEveryone', { writer }) : t('messaging.message.historyRestore', { writer, viewers })
    : everyone ? t('messaging.message.historyHideEveryone', { writer }) : t('messaging.message.historyHide', { writer, viewers });
  return (
    <li className="typography-meta text-muted-foreground">
      <span className="text-foreground">{text}</span>
      {` · ${time(op.time)}`}
      {op.reason ? <div>{t('messaging.message.historyReason', { reason: op.reason })}</div> : null}
    </li>
  );
};

/**
 * One message, as the inbox, a topic thread and search results show it: who
 * wrote it and when on one line, then the body as Markdown. Long bodies fold.
 * The menu holds what a reader can do with it; hiding never deletes, and the
 * history lists every hide and restore applied to it.
 */
export const MessagingMessageItem: React.FC<{
  message: MessagingMessage;
  /**
   * `thread`: the topic is on screen, so the line names the sequence number.
   * `search`: hits from many topics name theirs. `inbox`: every message is to
   * the person, so the line carries only the time.
   */
  variant: 'thread' | 'search' | 'inbox';
  focused?: boolean;
  /** Opens the topic at this message. */
  onOpenTopic?: () => void;
  onOpenSession?: () => void;
  /** Extra controls under the body, such as a reply field. */
  footer?: React.ReactNode;
  /** A thread can hide and restore its messages and show their history. */
  manageable?: boolean;
}> = ({ message, variant, focused = false, onOpenTopic, onOpenSession, footer, manageable = false }) => {
  const { t } = useI18n();
  const writer = useWriterName(message.writer);
  const topic = useTopicLabel(message.topic);
  const time = useMessageTime();
  const setHidden = useMessagingStore((state) => state.setHidden);
  const inspect = useMessagingStore((state) => state.inspect);
  const [expanded, setExpanded] = React.useState(false);
  const [history, setHistory] = React.useState<HistoryState>({ kind: 'closed' });
  const [visibilityError, setVisibilityError] = React.useState(false);
  const ref = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center' });
  }, [focused]);

  const long = message.data.length > FOLD_CHARACTERS || message.data.split('\n').length > FOLD_LINES;

  const changeVisibility = (hidden: boolean, forEveryone: boolean) => {
    setVisibilityError(false);
    void setHidden(message.topic, message.seq, hidden, forEveryone).then((ok) => setVisibilityError(!ok));
  };

  const toggleHistory = () => {
    if (history.kind !== 'closed') {
      setHistory({ kind: 'closed' });
      return;
    }
    setHistory({ kind: 'loading' });
    inspect(message.topic, message.seq).then(
      (inspected) => setHistory({ kind: 'ready', ops: inspected.ops ?? [] }),
      (caught) => setHistory({ kind: 'failed', error: caught instanceof Error ? caught.message : String(caught) }),
    );
  };

  const items = [
    ...(onOpenTopic ? [{ id: 'topic', label: t('messaging.message.openTopic'), onSelect: onOpenTopic }] : []),
    ...(onOpenSession ? [{ id: 'session', label: t('messaging.message.openSession'), onSelect: onOpenSession }] : []),
    ...(manageable
      ? message.hidden
        ? [
          { id: 'restore', label: t('messaging.message.restore'), onSelect: () => changeVisibility(false, false) },
          { id: 'restore-all', label: t('messaging.message.restoreForEveryone'), onSelect: () => changeVisibility(false, true) },
        ]
        : [
          { id: 'hide', label: t('messaging.message.hide'), onSelect: () => changeVisibility(true, false) },
          { id: 'hide-all', label: t('messaging.message.hideForEveryone'), onSelect: () => changeVisibility(true, true) },
        ]
      : []),
    ...(manageable ? [{ id: 'history', label: t('messaging.message.history'), onSelect: toggleHistory }] : []),
  ];

  const meta = [
    time(message.time),
    ...(variant === 'thread' ? [`#${message.seq}`] : variant === 'search' ? [`${topic}#${message.seq}`] : []),
    ...(message.type === 'message' || variant === 'inbox' ? [] : [message.type]),
  ].join(' · ');

  return (
    <article
      ref={ref}
      className={cn(
        'group/knowledge oc-tile rounded-lg px-3 py-2',
        focused && 'bg-interactive-selection/40',
        message.hidden && 'opacity-70',
      )}
    >
      <header className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate typography-ui-label font-medium text-foreground" title={message.writer}>{writer}</span>
        <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground" title={`${message.topic}#${message.seq}`}>{meta}</span>
        {message.hidden ? (
          <span className="oc-tile-inset flex-shrink-0 rounded px-1.5 typography-micro text-muted-foreground">{t('messaging.message.hidden')}</span>
        ) : null}
        {items.length > 0 ? <KnowledgeMenu items={items} /> : null}
      </header>
      {message.reply ? (
        <div className="typography-meta text-muted-foreground">{t('messaging.message.replyTo', { seq: message.reply })}</div>
      ) : null}
      <div className={cn('relative mt-1 min-w-0 overflow-hidden', long && !expanded && 'max-h-40')}>
        <SimpleMarkdownRenderer content={message.data} className="typography-markdown-body" enableFileReferences={false} />
      </div>
      {long ? (
        <button
          type="button"
          className="mt-1 typography-meta text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? t('messaging.message.showLess') : t('messaging.message.showMore')}
        </button>
      ) : null}
      {history.kind !== 'closed' ? (
        <div className="mt-2">
          {history.kind === 'ready' ? (
            history.ops.length > 0 ? (
              <ul className="space-y-1">{history.ops.map((op) => <OpLine key={op.seq} op={op} />)}</ul>
            ) : (
              <MessagingStatusLine text={t('messaging.message.historyEmpty')} />
            )
          ) : (
            <MessagingStatusLine
              text={history.kind === 'loading' ? t('messaging.status.loading') : t('messaging.message.historyFailed', { error: history.error })}
              tone={history.kind === 'failed' ? 'error' : 'muted'}
            />
          )}
        </div>
      ) : null}
      {visibilityError ? <MessagingStatusLine text={t('messaging.message.visibilityFailed')} tone="error" /> : null}
      {footer}
    </article>
  );
};
