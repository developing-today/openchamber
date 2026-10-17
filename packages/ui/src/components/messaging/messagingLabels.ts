import React from 'react';

import { useI18n, type I18nKey } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { MESSAGING_USER, isMessagingSession, type MessagingMatchMode } from '@/lib/opencode/messaging';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';

export const MATCH_LABEL_KEYS = {
  hybrid: 'messaging.match.hybrid',
  semantic: 'messaging.match.semantic',
  fuzzy: 'messaging.match.fuzzy',
  exact: 'messaging.match.exact',
  regex: 'messaging.match.regex',
  advanced: 'messaging.match.advanced',
} as const satisfies Record<MessagingMatchMode, I18nKey>;

/**
 * The name a writer goes by in the panel: "You" for the person, the session's
 * title when this client knows the session, else its ID.
 */
export const useWriterName = (writer: string, fallbackTitle?: string): string => {
  const { t } = useI18n();
  const title = useGlobalSessionsStore((state) => (isMessagingSession(writer) ? state.entityById.get(writer)?.title : undefined));
  if (writer === MESSAGING_USER) return t('messaging.message.you');
  return title?.trim() || fallbackTitle?.trim() || writer;
};

const SESSION_ID = /ses_[A-Za-z0-9_-]+/g;

/**
 * A topic name as people read it: the session IDs standard topic names carry
 * replaced by the titles this client knows (`Design the API/private`). Views
 * keep the raw name in a tooltip, since that is what agents and the CLI use.
 */
export const useTopicLabel = (name: string): string =>
  useGlobalSessionsStore((state) => name.replace(SESSION_ID, (id) => state.entityById.get(id)?.title.trim() || id));

/** Short date and time in the user's time format. */
export const useMessageTime = (): ((timestamp: number) => string) => {
  const preference = useUIStore((state) => state.timeFormatPreference);
  return React.useCallback(
    (timestamp: number) => formatDateTimeForPreference(timestamp, preference, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    [preference],
  );
};
