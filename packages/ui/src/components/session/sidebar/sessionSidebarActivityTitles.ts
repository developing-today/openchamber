import type { I18nKey } from '@/lib/i18n';
import type { SessionSidebarActivityKey } from './sessionSidebarRowModel';

/** The title of each zone header, also used by the display menu's section list. */
export const ACTIVITY_TITLE_KEY = {
  chats: 'sessions.sidebar.activity.chatsTitle',
  pinned: 'sessions.sidebar.activity.pinnedTitle',
  work: 'sessions.sidebar.work.title',
  approvals: 'sessions.sidebar.zone.approvals',
  questions: 'sessions.sidebar.zone.questions',
  blocked: 'sessions.sidebar.zone.blocked',
  attention: 'sessions.sidebar.zone.attention',
  pending: 'sessions.sidebar.zone.pending',
  errors: 'sessions.sidebar.zone.errors',
  stopped: 'sessions.sidebar.zone.stopped',
  'other-approvals': 'sessions.sidebar.zone.otherApprovals',
  'other-questions': 'sessions.sidebar.zone.otherQuestions',
  'other-blocked': 'sessions.sidebar.zone.otherBlocked',
  'other-attention': 'sessions.sidebar.zone.otherAttention',
  'other-errors': 'sessions.sidebar.zone.otherErrors',
  'other-stopped': 'sessions.sidebar.zone.otherStopped',
  'other-active': 'sessions.sidebar.zone.otherActive',
  all: 'sessions.sidebar.zone.all',
  timeline: 'sessions.sidebar.activity.projectsTitle',
} satisfies Record<SessionSidebarActivityKey, I18nKey>;
