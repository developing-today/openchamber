import React from 'react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { isMessagingSession, type MessagingMessage } from '@/lib/opencode/messaging';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { useMessagingStore } from '@/stores/useMessagingStore';
import { MessagingComposer } from './MessagingComposer';
import { MessagingMessageItem } from './MessagingMessageItem';
import { MessagingStatusLine } from './MessagingStatusLine';
import { useWriterName } from './messagingLabels';

const InboxItem: React.FC<{ message: MessagingMessage }> = ({ message }) => {
  const { t } = useI18n();
  const writer = useWriterName(message.writer);
  const sendToSession = useMessagingStore((state) => state.sendToSession);
  const openTopicAt = useMessagingStore((state) => state.openTopicAt);
  const [replying, setReplying] = React.useState(false);
  const fromSession = isMessagingSession(message.writer);

  return (
    <MessagingMessageItem
      message={message}
      variant="inbox"
      onOpenTopic={() => openTopicAt(message.topic, message.seq)}
      onOpenSession={fromSession ? () => void openSessionLink(message.writer, null) : undefined}
      footer={fromSession ? (
        replying ? (
          <div className="mt-2">
            <MessagingComposer
              placeholder={t('messaging.message.replyPlaceholder', { title: writer })}
              autoFocus
              onSend={async (text, force) => {
                // A reply wakes the session, the way answering it in the chat would.
                const outcome = await sendToSession(message.writer, text, 'wake', { force });
                if (outcome.kind === 'sent') setReplying(false);
                return outcome;
              }}
            />
          </div>
        ) : (
          <Button type="button" variant="ghost" size="xs" className="mt-1 -ms-2" onClick={() => setReplying(true)}>
            {t('messaging.message.reply')}
          </Button>
        )
      ) : null}
    />
  );
};

/**
 * Messages sessions sent up to the person through their user topics, newest first,
 * from every project. Each one can be answered in place: the reply goes to
 * the session that wrote it.
 */
export const MessagingInbox: React.FC<{ active: boolean }> = ({ active }) => {
  const { t } = useI18n();
  const inbox = useMessagingStore((state) => state.inbox);
  const loadInbox = useMessagingStore((state) => state.loadInbox);

  React.useEffect(() => {
    if (active) void loadInbox();
  }, [active, loadInbox]);

  const messages = inbox.data ?? [];
  const status = inbox.error
    ? t('messaging.status.failed', { error: inbox.error })
    : inbox.loading && messages.length === 0
      ? t('messaging.status.loading')
      : null;

  return (
    <div className="space-y-2">
      {status || (messages.length === 0 && inbox.key !== null) ? (
        <MessagingStatusLine
          text={status ?? t('messaging.inbox.empty')}
          tone={inbox.error ? 'error' : 'muted'}
          action={inbox.error ? (
            <Button type="button" variant="outline" size="xs" onClick={() => void loadInbox()}>{t('messaging.status.retry')}</Button>
          ) : null}
        />
      ) : null}
      {messages.map((message) => <InboxItem key={message.id} message={message} />)}
    </div>
  );
};
