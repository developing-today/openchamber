import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsCheckboxRow, SettingsChipGroup, SettingsRadioGroup, SettingsRadioOption, SETTINGS_FIELD_LABEL_CLASS, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { KNOWLEDGE_ICON_BUTTON_CLASS } from '@/components/session/project-context/knowledgeRowStyle';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { MESSAGING_USER, getMessagingTopic, isMessagingSession, type MessagingTopic, type MessagingWriteMode, type MessagingWriter } from '@/lib/opencode/messaging';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { cn } from '@/lib/utils';
import { useMessagingStore } from '@/stores/useMessagingStore';
import { MessagingComposer } from './MessagingComposer';
import { MessagingMessageItem } from './MessagingMessageItem';
import { MessagingStatusLine } from './MessagingStatusLine';
import { useMessageTime, useTopicLabel } from './messagingLabels';

/** Width of the topic list beside an open thread. */
const LIST_WIDTH_PX = 340;

const TopicRow: React.FC<{ topic: MessagingTopic; selected: boolean; onOpen: () => void }> = ({ topic, selected, onOpen }) => {
  const { t } = useI18n();
  const time = useMessageTime();
  const label = useTopicLabel(topic.name);
  const meta = [
    topic.kind,
    topic.exists
      ? topic.messages === 1 ? t('messaging.topics.countSingle', { count: topic.messages }) : t('messaging.topics.countPlural', { count: topic.messages })
      : t('messaging.topics.unused'),
    ...(topic.last ? [time(topic.last)] : []),
  ].join(' · ');
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      title={topic.name}
      className={cn(
        'oc-tile oc-tile-hover flex w-full min-w-0 flex-col items-start rounded-lg px-3 py-1.5 text-start',
        selected && 'bg-interactive-selection text-interactive-selection-foreground',
        !topic.exists && 'opacity-75',
      )}
    >
      <span className="w-full truncate typography-ui-label text-foreground">{label}</span>
      <span className="w-full truncate typography-meta text-muted-foreground">{meta}</span>
    </button>
  );
};

/**
 * Opens a topic by what a person would type: a raw name, a preset such as
 * `global` or `root`, or a template. OpenCode resolves it for the current
 * session, so `private` means this session's private topic.
 */
const OpenTopicField: React.FC<{ sessionID: string | null }> = ({ sessionID }) => {
  const { t } = useI18n();
  const openTopicAt = useMessagingStore((state) => state.openTopicAt);
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const open = async () => {
    const name = value.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const topic = await getMessagingTopic({ as: sessionID ?? undefined, topic: name });
      setValue('');
      openTopicAt(topic.name);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-1">
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void open();
          }}
          placeholder={t('messaging.topics.openPlaceholder')}
          aria-label={t('messaging.topics.openPlaceholder')}
          className="h-8 min-w-0 flex-1 rounded-md px-3"
        />
        <Button type="button" variant="outline" size="sm" disabled={busy || value.trim().length === 0} onClick={() => void open()}>
          {t('messaging.topics.openAction')}
        </Button>
      </div>
      <MessagingStatusLine text={error} tone="error" />
    </div>
  );
};

const TopicList: React.FC<{ sessionID: string | null }> = ({ sessionID }) => {
  const { t } = useI18n();
  const topics = useMessagingStore((state) => state.topics);
  const scope = useMessagingStore((state) => state.topicScope);
  const openTopic = useMessagingStore((state) => state.openTopic);
  const setView = useMessagingStore((state) => state.setView);
  const loadTopics = useMessagingStore((state) => state.loadTopics);
  const openTopicAt = useMessagingStore((state) => state.openTopicAt);

  React.useEffect(() => {
    void loadTopics(sessionID);
  }, [loadTopics, scope, sessionID]);

  // Topics in use first, newest first; a session's standard topics nobody used yet follow.
  const list = React.useMemo(() => {
    const all = topics.data ?? [];
    return [...all.filter((topic) => topic.exists).sort((a, b) => (b.last ?? 0) - (a.last ?? 0)), ...all.filter((topic) => !topic.exists)];
  }, [topics.data]);
  const status = topics.error
    ? t('messaging.status.failed', { error: topics.error })
    : topics.loading && list.length === 0
      ? t('messaging.status.loading')
      : list.length === 0 && topics.key !== null
        ? t('messaging.topics.empty')
        : null;

  return (
    <div className="space-y-2">
      {sessionID ? (
        <SettingsChipGroup
          aria-label={t('messaging.topics.scope')}
          value={scope}
          onChange={(value) => setView({ topicScope: value })}
          options={[
            { value: 'session', label: t('messaging.topics.scope.session') },
            { value: 'all', label: t('messaging.topics.scope.all') },
          ]}
        />
      ) : null}
      <OpenTopicField sessionID={sessionID} />
      {status ? (
        <MessagingStatusLine
          text={status}
          tone={topics.error ? 'error' : 'muted'}
          action={topics.error ? (
            <Button type="button" variant="outline" size="xs" onClick={() => void loadTopics(sessionID)}>{t('messaging.status.retry')}</Button>
          ) : null}
        />
      ) : null}
      <div className="space-y-1">
        {list.map((topic) => (
          <TopicRow key={topic.name} topic={topic} selected={topic.name === openTopic} onOpen={() => openTopicAt(topic.name)} />
        ))}
      </div>
    </div>
  );
};

const DELIVERY_LABEL_KEYS = {
  off: 'messaging.topicSettings.delivery.off',
  inbox: 'messaging.topicSettings.delivery.inbox',
  wake: 'messaging.topicSettings.delivery.wake',
} as const;
type DeliveryChoice = keyof typeof DELIVERY_LABEL_KEYS;
const DELIVERY_CHOICES: readonly DeliveryChoice[] = ['off', 'inbox', 'wake'];

const MODE_LABEL_KEYS = {
  open: 'messaging.topicSettings.mode.open',
  readonly: 'messaging.topicSettings.mode.readonly',
  limited: 'messaging.topicSettings.mode.limited',
} as const satisfies Record<MessagingWriteMode, string>;
const MODES: readonly MessagingWriteMode[] = ['open', 'readonly', 'limited'];

const TopicSettingsDialog: React.FC<{
  topic: MessagingTopic;
  sessionID: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ topic, sessionID, open, onOpenChange }) => {
  const { t } = useI18n();
  const saveTopicSettings = useMessagingStore((state) => state.saveTopicSettings);
  const subscribe = useMessagingStore((state) => state.subscribe);
  const [mode, setMode] = React.useState<MessagingWriteMode>(topic.mode);
  const [writers, setWriters] = React.useState<MessagingWriter[]>(topic.writers);
  const [description, setDescription] = React.useState(topic.description ?? '');
  const subscribed: DeliveryChoice = topic.subscribed === 'inbox' || topic.subscribed === 'wake' ? topic.subscribed : 'off';
  const [delivery, setDelivery] = React.useState<DeliveryChoice>(subscribed);
  const [draftWriter, setDraftWriter] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Each opening starts from what OpenCode reports now.
  React.useEffect(() => {
    if (!open) return;
    setMode(topic.mode);
    setWriters(topic.writers);
    setDescription(topic.description ?? '');
    setDelivery(subscribed);
    setDraftWriter('');
    setError(null);
  }, [open, subscribed, topic]);

  const names = (participants: { session: string; title?: string }[] | undefined) =>
    (participants ?? [])
      .map((participant) => (participant.session === MESSAGING_USER ? t('messaging.message.you') : participant.title?.trim() || participant.session))
      .join(', ');
  const label = useTopicLabel(topic.name);
  const wrote = names(topic.writersWindow?.latest);
  const read = names(topic.readersWindow?.latest);

  const save = async () => {
    setSaving(true);
    setError(null);
    const settingsChanged = mode !== topic.mode
      || description !== (topic.description ?? '')
      || JSON.stringify(writers) !== JSON.stringify(topic.writers);
    const saved = settingsChanged ? await saveTopicSettings(topic.name, { mode, writers, description }) : true;
    const deliveryChanged = sessionID !== null && delivery !== subscribed;
    const deliverySaved = deliveryChanged && sessionID
      ? await subscribe(sessionID, topic.name, delivery === 'off' ? null : delivery)
      : true;
    setSaving(false);
    if (!saved) setError(t('messaging.topicSettings.saveFailed'));
    else if (!deliverySaved) setError(t('messaging.topicSettings.subscribeFailed'));
    else onOpenChange(false);
  };

  const addWriter = () => {
    const session = draftWriter.trim();
    if (!session || writers.some((writer) => writer.session === session)) return;
    setWriters([...writers, { session }]);
    setDraftWriter('');
  };

  const updateWriter = (index: number, change: Partial<MessagingWriter>) =>
    setWriters(writers.map((writer, position) => (position === index ? { ...writer, ...change } : writer)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">{t('messaging.topicSettings.title', { topic: label })}</DialogTitle>
          {label !== topic.name ? <DialogDescription className="break-all font-mono typography-micro">{topic.name}</DialogDescription> : null}
        </DialogHeader>
        <div className="max-h-[60vh] space-y-5 overflow-y-auto">
          <div className="space-y-2">
            <div className={SETTINGS_FIELD_LABEL_CLASS}>{t('messaging.topicSettings.mode')}</div>
            <SettingsRadioGroup aria-label={t('messaging.topicSettings.mode')}>
              {MODES.map((value) => (
                <SettingsRadioOption
                  key={value}
                  selected={mode === value}
                  onSelect={() => setMode(value)}
                  label={t(MODE_LABEL_KEYS[value])}
                />
              ))}
            </SettingsRadioGroup>
            <p className={SETTINGS_HELPER_CLASS}>{t('messaging.topicSettings.rule', { policy: topic.policy })}</p>
            <p className={SETTINGS_HELPER_CLASS}>{t('messaging.topicSettings.softLimit')}</p>
          </div>

          {mode === 'limited' ? (
            <div className="space-y-2">
              <div className={SETTINGS_FIELD_LABEL_CLASS}>{t('messaging.topicSettings.writers')}</div>
              {writers.map((writer, index) => (
                <div key={writer.session} className="space-y-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono typography-meta text-foreground" title={writer.session}>{writer.session}</span>
                    <button
                      type="button"
                      className={KNOWLEDGE_ICON_BUTTON_CLASS}
                      aria-label={t('messaging.topicSettings.writerRemove', { session: writer.session })}
                      title={t('messaging.topicSettings.writerRemove', { session: writer.session })}
                      onClick={() => setWriters(writers.filter((_, position) => position !== index))}
                    >
                      <Icon name="close" className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-x-4">
                    <SettingsCheckboxRow
                      checked={writer.children === true}
                      onChange={(checked) => updateWriter(index, { children: checked || undefined })}
                      label={t('messaging.topicSettings.writerChildren')}
                    />
                    <SettingsCheckboxRow
                      checked={writer.ancestors === true}
                      onChange={(checked) => updateWriter(index, { ancestors: checked || undefined })}
                      label={t('messaging.topicSettings.writerAncestors')}
                    />
                  </div>
                </div>
              ))}
              <div className="flex items-center gap-1">
                <Input
                  value={draftWriter}
                  onChange={(event) => setDraftWriter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') addWriter();
                  }}
                  placeholder={t('messaging.topicSettings.writerPlaceholder')}
                  aria-label={t('messaging.topicSettings.writerPlaceholder')}
                  className="h-8 min-w-0 flex-1 rounded-md px-3 font-mono text-xs"
                />
                <Button type="button" variant="outline" size="sm" disabled={draftWriter.trim().length === 0} onClick={addWriter}>
                  {t('messaging.topicSettings.writerAdd')}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <div className={SETTINGS_FIELD_LABEL_CLASS}>{t('messaging.topicSettings.description')}</div>
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              aria-label={t('messaging.topicSettings.description')}
              className="h-8 w-full rounded-md px-3"
            />
          </div>

          {sessionID ? (
            <div className="space-y-2">
              <div className={SETTINGS_FIELD_LABEL_CLASS}>{t('messaging.topicSettings.delivery')}</div>
              <SettingsChipGroup
                aria-label={t('messaging.topicSettings.delivery')}
                value={delivery}
                onChange={setDelivery}
                options={DELIVERY_CHOICES.map((value) => ({ value, label: t(DELIVERY_LABEL_KEYS[value]) }))}
              />
            </div>
          ) : null}

          {wrote || read ? (
            <div className="space-y-1">
              {wrote ? <p className={SETTINGS_HELPER_CLASS}>{t('messaging.topicSettings.wrote', { names: wrote })}</p> : null}
              {read ? <p className={SETTINGS_HELPER_CLASS}>{t('messaging.topicSettings.read', { names: read })}</p> : null}
            </div>
          ) : null}
        </div>
        <MessagingStatusLine text={error} tone="error" />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('messaging.topicSettings.cancel')}</Button>
          <Button type="button" disabled={saving} onClick={() => void save()}>{t('messaging.topicSettings.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const TopicThread: React.FC<{ topicName: string; sessionID: string | null; withBack: boolean }> = ({ topicName, sessionID, withBack }) => {
  const { t } = useI18n();
  const thread = useMessagingStore((state) => state.thread);
  const topic = useMessagingStore((state) => state.topic);
  const showHidden = useMessagingStore((state) => state.showHidden);
  const focusSeq = useMessagingStore((state) => state.focusSeq);
  const setView = useMessagingStore((state) => state.setView);
  const loadThread = useMessagingStore((state) => state.loadThread);
  const loadTopic = useMessagingStore((state) => state.loadTopic);
  const sendToTopic = useMessagingStore((state) => state.sendToTopic);
  const openTopicAt = useMessagingStore((state) => state.openTopicAt);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const label = useTopicLabel(topicName);

  React.useEffect(() => {
    void loadTopic(topicName);
  }, [loadTopic, topicName]);
  React.useEffect(() => {
    void loadThread(topicName);
  }, [loadThread, topicName, showHidden]);

  const threadKey = JSON.stringify([topicName, showHidden]);
  const messages = thread.key === threadKey ? thread.data?.messages ?? [] : [];
  const more = thread.key === threadKey && thread.data?.more === true;
  const info = topic.key === topicName ? topic.data : null;
  const lastSeq = messages.at(-1)?.seq;

  // New messages land at the bottom; follow them unless a message was asked for.
  React.useEffect(() => {
    if (focusSeq !== null) return;
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [focusSeq, lastSeq]);

  const status = thread.key === threadKey && thread.error
    ? t('messaging.status.failed', { error: thread.error })
    : thread.loading && messages.length === 0
      ? t('messaging.status.loading')
      : messages.length === 0 && thread.key === threadKey
        ? t('messaging.thread.empty')
        : null;

  const meta = [info?.kind, info?.description, info?.policy].filter(Boolean).join(' · ');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-w-0 flex-shrink-0 items-center gap-1 pb-1">
        {withBack ? (
          <Button type="button" variant="ghost" size="xs" className="-ms-2" onClick={() => setView({ openTopic: null, focusSeq: null })}>
            <Icon name="arrow-left-s" className="h-3.5 w-3.5" />
            {t('messaging.thread.back')}
          </Button>
        ) : null}
        <span className="min-w-0 flex-1 truncate typography-ui-label font-medium text-foreground" title={topicName}>{label}</span>
        <button
          type="button"
          className={cn(KNOWLEDGE_ICON_BUTTON_CLASS, showHidden && 'text-foreground')}
          aria-pressed={showHidden}
          aria-label={t('messaging.thread.showHidden')}
          title={t('messaging.thread.showHidden')}
          onClick={() => setView({ showHidden: !showHidden })}
        >
          <Icon name={showHidden ? 'eye' : 'eye-off'} className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={KNOWLEDGE_ICON_BUTTON_CLASS}
          aria-label={t('messaging.thread.settings')}
          title={t('messaging.thread.settings')}
          disabled={!info}
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="settings-3" className="h-3.5 w-3.5" />
        </button>
      </div>
      {meta ? <div className="flex-shrink-0 truncate pb-1 typography-meta text-muted-foreground" title={meta}>{meta}</div> : null}
      <div ref={scrollerRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-2">
        {more ? (
          <Button type="button" variant="ghost" size="xs" onClick={() => void loadThread(topicName, { more: true })}>
            {t('messaging.thread.loadEarlier')}
          </Button>
        ) : null}
        {status ? (
          <MessagingStatusLine
            text={status}
            tone={thread.error ? 'error' : 'muted'}
            action={thread.error ? (
              <Button type="button" variant="outline" size="xs" onClick={() => void loadThread(topicName)}>{t('messaging.status.retry')}</Button>
            ) : null}
          />
        ) : null}
        {messages.map((message) => (
          <MessagingMessageItem
            key={message.id}
            message={message}
            variant="thread"
            focused={message.seq === focusSeq}
            manageable
            onOpenSession={isMessagingSession(message.writer) ? () => void openSessionLink(message.writer, null) : undefined}
          />
        ))}
      </div>
      <div className="flex-shrink-0">
        <MessagingComposer
          placeholder={t('messaging.thread.writePlaceholder', { topic: label })}
          onSend={(text, force) => {
            if (focusSeq !== null) openTopicAt(topicName);
            return sendToTopic(topicName, text, { force });
          }}
        />
      </div>
      {info ? <TopicSettingsDialog topic={info} sessionID={sessionID} open={settingsOpen} onOpenChange={setSettingsOpen} /> : null}
    </div>
  );
};

/**
 * Topics the current session reads, writes or owns (its standard topics are
 * listed before first use), or every topic. A wide panel shows the list and
 * the open topic side by side; a narrow one swaps between them.
 */
export const MessagingTopics: React.FC<{ sessionID: string | null; split: boolean }> = ({ sessionID, split }) => {
  const { t } = useI18n();
  const openTopic = useMessagingStore((state) => state.openTopic);

  if (split) {
    return (
      <div className="flex h-full min-h-0">
        <div className="h-full flex-shrink-0 overflow-y-auto border-e border-border/60 p-3" style={{ width: LIST_WIDTH_PX }}>
          <TopicList sessionID={sessionID} />
        </div>
        <div className="h-full min-w-0 flex-1 p-3">
          {openTopic ? (
            <TopicThread key={openTopic} topicName={openTopic} sessionID={sessionID} withBack={false} />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center typography-meta text-muted-foreground">
              {t('messaging.thread.selectHint')}
            </div>
          )}
        </div>
      </div>
    );
  }

  return openTopic ? (
    <div className="h-full min-h-0 p-3">
      <TopicThread key={openTopic} topicName={openTopic} sessionID={sessionID} withBack />
    </div>
  ) : (
    <div className="h-full overflow-y-auto p-3">
      <TopicList sessionID={sessionID} />
    </div>
  );
};
