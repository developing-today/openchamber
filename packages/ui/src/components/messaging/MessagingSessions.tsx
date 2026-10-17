import React from 'react';

import { SettingsChipGroup } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { formatCompactNumber } from '@/lib/numberFormat';
import { MESSAGING_LOG_PARTS, type MessagingDelivery, type MessagingLogEntry, type MessagingLogPart, type MessagingSessionNode } from '@/lib/opencode/messaging';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { cn } from '@/lib/utils';
import { useMessagingStore, type MessagingLogOp } from '@/stores/useMessagingStore';
import { useKnowledgeRevealClass } from '@/components/session/project-context/knowledgeRowStyle';
import { MessagingComposer } from './MessagingComposer';
import { MessagingStatusLine } from './MessagingStatusLine';
import { useMessageTime } from './messagingLabels';

const LOG_PART_KEYS = {
  user: 'messaging.log.part.user',
  output: 'messaging.log.part.output',
  thinking: 'messaging.log.part.thinking',
  tools: 'messaging.log.part.tools',
  results: 'messaging.log.part.results',
  system: 'messaging.log.part.system',
  synthetic: 'messaging.log.part.synthetic',
  shell: 'messaging.log.part.shell',
  compaction: 'messaging.log.part.compaction',
  events: 'messaging.log.part.events',
} as const satisfies Record<MessagingLogPart, I18nKey>;

const LOG_OP_KEYS = {
  tail: 'messaging.log.op.tail',
  head: 'messaging.log.op.head',
  grep: 'messaging.log.op.grep',
  search: 'messaging.log.op.search',
} as const satisfies Record<MessagingLogOp, I18nKey>;
const LOG_OPS: readonly MessagingLogOp[] = ['tail', 'head', 'grep', 'search'];

const SectionTitle: React.FC<{ children: React.ReactNode; action?: React.ReactNode }> = ({ children, action }) => (
  <div className="flex min-h-7 items-center justify-between gap-2">
    <h3 className="typography-ui-label font-medium text-foreground">{children}</h3>
    {action}
  </div>
);

/** Writes to one session: it lands in that session's user topic and is queued, or queued and started. */
const DirectMessage: React.FC<{ node: MessagingSessionNode; title: string; onSent: () => void }> = ({ node, title, onSent }) => {
  const { t } = useI18n();
  const sendToSession = useMessagingStore((state) => state.sendToSession);
  const [deliver, setDeliver] = React.useState<Exclude<MessagingDelivery, 'none'>>('inbox');
  return (
    <div className="mt-2 space-y-1">
      <SettingsChipGroup
        aria-label={t('messaging.sessions.message')}
        value={deliver}
        onChange={setDeliver}
        options={[
          { value: 'inbox', label: t('messaging.sessions.deliver.inbox') },
          { value: 'wake', label: t('messaging.sessions.deliver.wake') },
        ]}
      />
      <MessagingComposer
        placeholder={t('messaging.sessions.messagePlaceholder', { title })}
        autoFocus
        onSend={async (text, force) => {
          const outcome = await sendToSession(node.id, text, deliver, { force });
          if (outcome.kind === 'sent') onSent();
          return outcome;
        }}
      />
    </div>
  );
};

const SessionNodeRow: React.FC<{ node: MessagingSessionNode; label?: string; detail: boolean }> = ({ node, label, detail }) => {
  const { t } = useI18n();
  const time = useMessageTime();
  const reveal = useKnowledgeRevealClass();
  const [messaging, setMessaging] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const title = node.title?.trim() || t('messaging.sessions.untitled');
  const meta = [
    ...(label ? [label] : []),
    ...(node.agent ? [node.agent] : []),
    ...(node.status === 'running' ? [t('messaging.sessions.running')] : []),
    ...(node.updated ? [time(node.updated)] : []),
  ].join(' · ');
  const fields: Array<{ key: I18nKey; value: string | undefined }> = detail
    ? [
      { key: 'messaging.sessions.field.directory', value: node.directory },
      { key: 'messaging.sessions.field.model', value: node.model },
      { key: 'messaging.sessions.field.messages', value: node.messages === undefined ? undefined : formatCompactNumber(node.messages) },
      { key: 'messaging.sessions.field.tokens', value: node.tokens === undefined ? undefined : formatCompactNumber(node.tokens) },
      { key: 'messaging.sessions.field.cost', value: node.cost === undefined ? undefined : formatMoney(node.cost) },
      { key: 'messaging.sessions.field.topics', value: node.topics === undefined ? undefined : String(node.topics) },
      {
        key: 'messaging.sessions.field.children',
        value: node.children === undefined
          ? undefined
          : [String(node.children), (node.childWindow?.latest ?? []).map((child) => child.title?.trim() || child.id).join(', ')].filter(Boolean).join(' · '),
      },
    ]
    : [];
  const shownFields = fields.flatMap((field) => (field.value === undefined ? [] : [{ key: field.key, value: field.value }]));

  return (
    <div className="group/knowledge oc-tile rounded-lg px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          className="min-w-0 truncate text-start typography-ui-label font-medium text-foreground/80 hover:text-foreground"
          title={t('messaging.sessions.open')}
          onClick={() => void openSessionLink(node.id, null)}
        >
          {title}
        </button>
        <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground" title={meta}>{meta}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className={reveal}
          aria-expanded={messaging}
          onClick={() => {
            setMessaging((value) => !value);
            setSent(false);
          }}
        >
          {t('messaging.sessions.message')}
        </Button>
      </div>
      {shownFields.length > 0 ? (
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 typography-meta">
          {shownFields.map(({ key, value }) => (
            <React.Fragment key={key}>
              <dt className="text-muted-foreground">{t(key)}</dt>
              <dd className="min-w-0 truncate text-foreground" title={value}>{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
      {messaging ? (
        <DirectMessage
          node={node}
          title={title}
          onSent={() => {
            setMessaging(false);
            setSent(true);
          }}
        />
      ) : null}
      {sent ? <MessagingStatusLine text={t('messaging.sessions.sent', { title })} /> : null}
    </div>
  );
};

const ChainSection: React.FC<{ sessionID: string }> = ({ sessionID }) => {
  const { t } = useI18n();
  const chain = useMessagingStore((state) => state.chain);
  const detail = useMessagingStore((state) => state.chainDetail);
  const setView = useMessagingStore((state) => state.setView);
  const loadChain = useMessagingStore((state) => state.loadChain);

  React.useEffect(() => {
    void loadChain(sessionID);
  }, [detail, loadChain, sessionID]);

  const nodes = chain.data?.chain ?? [];
  return (
    <section className="space-y-1">
      <SectionTitle
        action={(
          <Button type="button" variant="chip" size="xs" aria-pressed={detail} onClick={() => setView({ chainDetail: !detail })}>
            {t('messaging.sessions.details')}
          </Button>
        )}
      >
        {t('messaging.sessions.chain')}
      </SectionTitle>
      {chain.error || (chain.loading && nodes.length === 0) ? (
        <MessagingStatusLine
          text={chain.error ? t('messaging.status.failed', { error: chain.error }) : t('messaging.status.loading')}
          tone={chain.error ? 'error' : 'muted'}
        />
      ) : null}
      <div className="space-y-1">
        {nodes.map((node, index) => (
          <SessionNodeRow
            key={node.id}
            node={node}
            detail={detail}
            label={index === 0 ? t('messaging.sessions.current') : index === nodes.length - 1 ? t('messaging.sessions.root') : undefined}
          />
        ))}
      </div>
    </section>
  );
};

const FindSection: React.FC = () => {
  const { t } = useI18n();
  const sessions = useMessagingStore((state) => state.sessions);
  const findQuery = useMessagingStore((state) => state.findQuery);
  const setView = useMessagingStore((state) => state.setView);
  const findSessions = useMessagingStore((state) => state.findSessions);
  const results = sessions.data ?? [];

  // Opens on the sessions active most recently, in every project.
  React.useEffect(() => {
    if (useMessagingStore.getState().sessions.key === null) void findSessions();
  }, [findSessions]);

  return (
    <section className="space-y-1">
      <SectionTitle>{t('messaging.sessions.find')}</SectionTitle>
      <Input
        value={findQuery}
        onChange={(event) => setView({ findQuery: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void findSessions();
        }}
        placeholder={t('messaging.sessions.findPlaceholder')}
        aria-label={t('messaging.sessions.findPlaceholder')}
        className="h-8 w-full rounded-md px-3"
      />
      <MessagingStatusLine
        text={
          sessions.error
            ? t('messaging.status.failed', { error: sessions.error })
            : sessions.loading
              ? t('messaging.status.loading')
              : sessions.key !== null && results.length === 0
                ? t('messaging.sessions.findEmpty')
                : null
        }
        tone={sessions.error ? 'error' : 'muted'}
      />
      <div className="space-y-1">
        {results.map((node) => <SessionNodeRow key={node.id} node={node} detail={false} />)}
      </div>
    </section>
  );
};

const LogEntryRow: React.FC<{ entry: MessagingLogEntry }> = ({ entry }) => {
  const { t } = useI18n();
  const time = useMessageTime();
  const meta = [t(LOG_PART_KEYS[entry.part]), ...(entry.tool ? [entry.tool] : []), time(entry.time)].join(' · ');
  return (
    <div className={cn('oc-tile rounded-lg px-3 py-1.5', entry.match === false && 'opacity-60')}>
      <div className="truncate typography-meta text-muted-foreground" title={meta}>{meta}</div>
      <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words typography-meta text-foreground">{entry.text}</div>
    </div>
  );
};

const LogSection: React.FC<{ sessionID: string }> = ({ sessionID }) => {
  const { t } = useI18n();
  const log = useMessagingStore((state) => state.log);
  const op = useMessagingStore((state) => state.logOp);
  const parts = useMessagingStore((state) => state.logParts);
  const query = useMessagingStore((state) => state.logQuery);
  const setView = useMessagingStore((state) => state.setView);
  const loadLog = useMessagingStore((state) => state.loadLog);
  const needsQuery = op === 'grep' || op === 'search';

  // Text searches run on Enter; everything else reads as soon as it changes.
  React.useEffect(() => {
    void loadLog(sessionID);
  }, [loadLog, op, parts, sessionID]);

  const togglePart = (part: MessagingLogPart) => {
    const next = parts.includes(part) ? parts.filter((item) => item !== part) : MESSAGING_LOG_PARTS.filter((item) => item === part || parts.includes(item));
    if (next.length > 0) setView({ logParts: next });
  };

  const entries = log.data?.entries ?? [];
  const status = log.error
    ? t('messaging.status.failed', { error: log.error })
    : log.loading && entries.length === 0
      ? t('messaging.status.loading')
      : log.key !== null && entries.length === 0
        ? t('messaging.log.empty')
        : log.data?.note ?? null;

  return (
    <section className="space-y-2">
      <SectionTitle>{t('messaging.log.title')}</SectionTitle>
      <SettingsChipGroup
        aria-label={t('messaging.log.op')}
        value={op}
        onChange={(value) => setView({ logOp: value })}
        options={LOG_OPS.map((value) => ({ value, label: t(LOG_OP_KEYS[value]) }))}
      />
      {needsQuery ? (
        <Input
          value={query}
          onChange={(event) => setView({ logQuery: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void loadLog(sessionID);
          }}
          placeholder={t('messaging.log.queryPlaceholder')}
          aria-label={t('messaging.log.queryPlaceholder')}
          className="h-8 w-full rounded-md px-3"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('messaging.log.parts')}>
        {MESSAGING_LOG_PARTS.map((part) => (
          <Button key={part} type="button" variant="chip" size="xs" aria-pressed={parts.includes(part)} onClick={() => togglePart(part)}>
            {t(LOG_PART_KEYS[part])}
          </Button>
        ))}
      </div>
      <MessagingStatusLine text={status} tone={log.error ? 'error' : 'muted'} />
      <div className="space-y-1">
        {entries.map((entry) => <LogEntryRow key={`${entry.message}:${entry.index}:${entry.part}`} entry={entry} />)}
      </div>
      {log.data?.more ? <MessagingStatusLine text={t('messaging.log.more')} /> : null}
    </section>
  );
};

/**
 * The current session's chain (itself, then each parent up to the root, with
 * details on demand), a search across every session, and the session's log
 * with the parts to include. Any session listed here can be messaged.
 */
export const MessagingSessions: React.FC<{ sessionID: string | null }> = ({ sessionID }) => {
  const { t } = useI18n();
  return (
    <div className="space-y-5">
      {sessionID ? <ChainSection sessionID={sessionID} /> : <MessagingStatusLine text={t('messaging.sessions.noSession')} />}
      <FindSection />
      {sessionID ? <LogSection sessionID={sessionID} /> : null}
    </div>
  );
};
