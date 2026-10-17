import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { ContextPanelHeaderToolbar } from '@/components/layout/contextPanelHeaderSlot';
import { useInContextPanelHeader } from '@/components/layout/contextPanelHeaderSlotContext';
import { Button } from '@/components/ui/button';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useMessagingStore, type MessagingTab } from '@/stores/useMessagingStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { MessagingInbox } from './MessagingInbox';
import { MessagingSearch } from './MessagingSearch';
import { MessagingSessions } from './MessagingSessions';
import { MessagingTopics } from './MessagingTopics';
import { MessagingStatusLine } from './MessagingStatusLine';

/** Panel width from which an open topic sits beside the topic list. */
const SPLIT_MIN_WIDTH = 760;

const TABS: Array<{ id: MessagingTab; icon: IconName; labelKey: I18nKey }> = [
  { id: 'inbox', icon: 'inbox', labelKey: 'messaging.tabs.inbox' },
  { id: 'topics', icon: 'hashtag', labelKey: 'messaging.tabs.topics' },
  { id: 'sessions', icon: 'node-tree', labelKey: 'messaging.tabs.sessions' },
];

/**
 * The Messages surface: what agents sent the person, the topics sessions
 * write to, and the current session's chain and log, from OpenCode's
 * messaging routes. Its sections and the search toggle fill the panel header.
 * Against an OpenCode without messaging it says so and offers to check again.
 */
export const MessagingPanel: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const inPanelHeader = useInContextPanelHeader();
  const isMobile = useUIStore((state) => state.isMobile);
  const sessionID = useSessionUIStore((state) => state.currentSessionId);
  const support = useMessagingStore((state) => state.support);
  const checkSupport = useMessagingStore((state) => state.checkSupport);
  const tab = useMessagingStore((state) => state.tab);
  const searchOpen = useMessagingStore((state) => state.searchOpen);
  const setView = useMessagingStore((state) => state.setView);

  React.useEffect(() => {
    void checkSupport();
  }, [checkSupport]);

  // The panel's own width decides the topic layout, however it got wide.
  const [rootNode, setRootNode] = React.useState<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!rootNode) return;
    setWidth(rootNode.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(rootNode);
    return () => observer.disconnect();
  }, [rootNode]);
  const split = !isMobile && width >= SPLIT_MIN_WIDTH;

  const searchLabel = t('messaging.search.toggle');
  const toolbar = (
    <div className="flex min-w-0 flex-1 items-center gap-1 pe-1">
      <nav className="@container/messaging-tabs flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label={t('messaging.tabs.label')}>
        {TABS.map((item) => {
          const active = !searchOpen && tab === item.id;
          const label = t(item.labelKey);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setView({ tab: item.id, searchOpen: false })}
              aria-current={active ? 'page' : undefined}
              title={label}
              className={cn(
                'flex h-7 flex-shrink-0 items-center gap-1.5 rounded-md px-2 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon name={item.icon} className="h-3.5 w-3.5 flex-shrink-0" />
              <span className={cn('whitespace-nowrap typography-meta', !active && (isMobile ? 'hidden' : 'hidden @[18rem]/messaging-tabs:inline'))}>
                {label}
              </span>
            </button>
          );
        })}
      </nav>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setView({ searchOpen: !searchOpen })}
        aria-pressed={searchOpen}
        className={cn('h-7 w-7 flex-shrink-0 p-0', searchOpen && 'bg-interactive-selection text-interactive-selection-foreground')}
        title={searchLabel}
        aria-label={searchLabel}
      >
        <Icon name="search" className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  const body = (() => {
    if (support.kind !== 'supported') {
      const failed = support.kind === 'failed';
      return (
        <div className="p-3">
          <MessagingStatusLine
            text={
              support.kind === 'unsupported'
                ? t('messaging.support.unsupported')
                : failed
                  ? t('messaging.support.failed', { error: support.error })
                  : t('messaging.support.checking')
            }
            tone={failed ? 'error' : 'muted'}
            action={support.kind === 'unsupported' || failed ? (
              <Button type="button" variant="outline" size="xs" onClick={() => void checkSupport({ force: true })}>
                {t('messaging.support.retry')}
              </Button>
            ) : null}
          />
        </div>
      );
    }
    if (searchOpen) return <div className="h-full overflow-y-auto p-3"><MessagingSearch /></div>;
    if (tab === 'topics') return <MessagingTopics sessionID={sessionID} split={split} />;
    return (
      <div className="h-full overflow-y-auto p-3">
        {tab === 'inbox' ? <MessagingInbox /> : <MessagingSessions sessionID={sessionID} />}
      </div>
    );
  })();

  return (
    <div ref={setRootNode} className={cn('flex h-full min-h-0 w-full min-w-0 flex-col', className)}>
      {inPanelHeader ? (
        <ContextPanelHeaderToolbar>{toolbar}</ContextPanelHeaderToolbar>
      ) : (
        <div className="flex flex-shrink-0 px-3 pt-2">{toolbar}</div>
      )}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
};
