import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { ACTIVITY_TITLE_KEY } from './sessionSidebarActivityTitles';
import type { SessionSidebarActivityKey } from './sessionSidebarRowModel';
import type { SortableDragHandleProps } from './projects/sortableItems';

const ACTIVITY_ICON = {
  chats: 'chat-4',
  pinned: 'pushpin',
  work: 'eye',
  approvals: 'shield',
  questions: 'question',
  blocked: 'alert',
  attention: 'alarm-warning',
  pending: 'time',
  errors: 'error-warning',
  stopped: 'stop',
  'other-approvals': 'shield',
  'other-questions': 'question',
  'other-blocked': 'alert',
  'other-attention': 'alarm-warning',
  'other-errors': 'error-warning',
  'other-stopped': 'stop',
  'other-active': 'pulse',
  all: 'list-unordered',
  // The list by time holds every project's sessions, so it is titled Projects;
  // its clock icon says how it is ordered.
  timeline: 'history',
} satisfies Record<SessionSidebarActivityKey, IconName>;

export const SessionSidebarActivityHeader: React.FC<{
  activityKey: SessionSidebarActivityKey;
  collapsed: boolean;
  forceExpanded: boolean;
  alwaysShowActions: boolean;
  /** Sessions in the zone, shown after its title; attention zones only. */
  count?: number;
  /** Set while the header can be dragged to reorder the sections. */
  dragHandleProps?: SortableDragHandleProps;
  onToggle: () => void;
  onNewChat: () => void;
}> = ({ activityKey, collapsed, forceExpanded, alwaysShowActions, count, dragHandleProps, onToggle, onNewChat }) => {
  const { t } = useI18n();
  const chats = activityKey === 'chats';
  // One header in both views, so zones line up with the project headers.
  return <div className="relative group/chats -ms-2.5 -me-2">
    <button
      type="button"
      ref={dragHandleProps?.setActivatorNodeRef}
      {...dragHandleProps?.listeners}
      // Enter and Space keep opening and closing the zone; the menu's
      // Section order moves it from the keyboard.
      onKeyDown={undefined}
      onClick={forceExpanded ? undefined : onToggle}
      disabled={forceExpanded}
      className={cn(
        'group flex w-full items-center gap-1.5 py-1 ps-4 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        chats ? 'pe-10' : 'pe-3.5',
        dragHandleProps && 'cursor-grab active:cursor-grabbing',
      )}
      aria-expanded={!collapsed}
    >
      <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
        <Icon name={ACTIVITY_ICON[activityKey]} className={cn('h-3.5 w-3.5 text-muted-foreground/80', !forceExpanded && 'group-hover:hidden')} />
        {!forceExpanded ? <span className="hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground group-hover:inline-flex">
          <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
        </span> : null}
      </span>
      {/* The size of project headers: zones and projects are sections of equal weight. */}
      <span className="typography-ui-header font-semibold text-foreground">
        {t(ACTIVITY_TITLE_KEY[activityKey])}
      </span>
      {count !== undefined ? <span className="typography-micro tabular-nums text-muted-foreground" dir="auto">{count}</span> : null}
    </button>
    {chats ? <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onNewChat(); }}
      className={cn('absolute inset-e-0.5 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/chats:opacity-100 group-hover/chats:pointer-events-auto group-has-[:focus-visible]/chats:opacity-100 group-has-[:focus-visible]/chats:pointer-events-auto')}
      aria-label={t('sessions.sidebar.header.actions.newSession')}
    >
      <Icon name="add" className="h-4 w-4" />
    </button> : null}
  </div>;
};
