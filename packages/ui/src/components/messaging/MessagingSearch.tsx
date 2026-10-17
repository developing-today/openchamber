import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { MESSAGING_MATCH_MODES, isMessagingSession } from '@/lib/opencode/messaging';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { useMessagingStore } from '@/stores/useMessagingStore';
import { MessagingMessageItem } from './MessagingMessageItem';
import { MessagingStatusLine } from './MessagingStatusLine';
import { MATCH_LABEL_KEYS } from './messagingLabels';

/**
 * Searches every topic. Meaning-based matches use OpenCode's embedding model;
 * when it is not ready, OpenCode matches words instead and says so in the
 * status line. A hit opens its topic at that message.
 */
export const MessagingSearch: React.FC = () => {
  const { t } = useI18n();
  const search = useMessagingStore((state) => state.search);
  const query = useMessagingStore((state) => state.searchQuery);
  const match = useMessagingStore((state) => state.searchMatch);
  const setView = useMessagingStore((state) => state.setView);
  const runSearch = useMessagingStore((state) => state.runSearch);
  const openTopicAt = useMessagingStore((state) => state.openTopicAt);

  // A new match mode re-runs the words already typed.
  React.useEffect(() => {
    if (useMessagingStore.getState().searchQuery.trim()) void runSearch();
  }, [match, runSearch]);

  const messages = search.data?.messages ?? [];
  const status = search.error
    ? t('messaging.status.failed', { error: search.error })
    : search.loading
      ? t('messaging.status.loading')
      : search.key !== null && messages.length === 0
        ? t('messaging.search.empty')
        : search.data?.note ?? null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <Input
          value={query}
          autoFocus
          onChange={(event) => setView({ searchQuery: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runSearch();
          }}
          placeholder={t('messaging.search.placeholder')}
          aria-label={t('messaging.search.placeholder')}
          className="h-8 min-w-0 flex-1 rounded-md px-3"
        />
        <Select value={match} onValueChange={(value) => setView({ searchMatch: MESSAGING_MATCH_MODES.find((mode) => mode === value) ?? 'hybrid' })}>
          <SelectTrigger className="max-w-[22ch]" aria-label={t('messaging.search.matchLabel')}>
            <SelectValue>{t(MATCH_LABEL_KEYS[match])}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {MESSAGING_MATCH_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>{t(MATCH_LABEL_KEYS[mode])}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <MessagingStatusLine
        text={status}
        tone={search.error ? 'error' : 'muted'}
        action={search.error ? (
          <Button type="button" variant="outline" size="xs" onClick={() => void runSearch()}>{t('messaging.status.retry')}</Button>
        ) : null}
      />
      <div className="space-y-2">
        {messages.map((message) => (
          <MessagingMessageItem
            key={message.id}
            message={message}
            variant="search"
            onOpenTopic={() => openTopicAt(message.topic, message.seq)}
            onOpenSession={isMessagingSession(message.writer) ? () => void openSessionLink(message.writer, null) : undefined}
          />
        ))}
      </div>
    </div>
  );
};
