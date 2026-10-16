import { describe, expect, test } from 'bun:test';
import type { OpenSessionLeave } from '@/stores/sidebarLayout';
import { resolveLeaveTarget } from './openSessionLeave';
import type { SessionSidebarNavigationEntry } from '../sessionSidebarRowModel';
import { reorderProjectHeadersWithChats, reorderSectionsByDrop } from './sectionDrag';
import { normalizeSectionOrder, type SidebarSectionKey } from '@/stores/sidebarLayout';

const entry = (sessionId: string, containerKey: string): SessionSidebarNavigationEntry => ({ sessionId, directory: '/repo', containerKey });

// Questions on top, In work under it, then the project, where `w2` shows again.
const entries = [
  entry('q1', 'activity:questions'),
  entry('w1', 'activity:work'),
  entry('w2', 'activity:work'),
  entry('w3', 'activity:work'),
  entry('p1', 'project-a:main'),
  entry('w2', 'project-a:main'),
];

const resolve = (policy: OpenSessionLeave, sessionId: string, extra: Partial<Parameters<typeof resolveLeaveTarget>[0]> = {}) => resolveLeaveTarget({
  policy,
  sessionId,
  leavingIds: new Set([sessionId]),
  entries,
  isAttentionContainer: (key) => key === 'activity:questions',
  isUnread: () => false,
  history: [],
  ...extra,
})?.sessionId ?? null;

describe('resolveLeaveTarget', () => {
  test('keeping the session open opens nothing else', () => {
    expect(resolve('hold', 'w2')).toBeNull();
    expect(resolve('stay', 'w2')).toBeNull();
    expect(resolve('reveal', 'w2')).toBeNull();
  });

  test('steps down or up within the same list first', () => {
    expect(resolve('down', 'w2')).toBe('w3');
    expect(resolve('up', 'w2')).toBe('w1');
    expect(resolve('down', 'w3')).toBe('p1');
    expect(resolve('up', 'w1')).toBe('q1');
  });

  test('turns around at the end of its list', () => {
    expect(resolve('down-up', 'w3')).toBe('w2');
    expect(resolve('up-down', 'w1')).toBe('w2');
  });

  test('opens the top session needing attention, else a finished unread one, else the first of its list', () => {
    expect(resolve('attention', 'w2')).toBe('q1');
    expect(resolve('attention', 'q1', { isUnread: (id) => id === 'p1' })).toBe('p1');
    expect(resolve('attention', 'q1')).toBeNull();
    expect(resolve('attention', 'w3', { isAttentionContainer: () => false })).toBe('w1');
  });

  test('goes back to the most recent earlier session still listed', () => {
    expect(resolve('previous', 'w2', { history: ['p1', 'gone', 'w1', 'w2'] })).toBe('w1');
  });

  test('never picks another session leaving in the same batch', () => {
    expect(resolve('down', 'w2', { leavingIds: new Set(['w2', 'w3']) })).toBe('p1');
  });
});

describe('section drag', () => {
  test('a section dropped on another lands on its far side', () => {
    const order = normalizeSectionOrder(['chats', 'pinned', 'work', 'projects']);
    const drawn: readonly SidebarSectionKey[] = ['chats', 'work', 'projects'];
    const down = reorderSectionsByDrop(order, drawn, 'chats', 'work');
    expect(down.filter((key) => drawn.includes(key))).toEqual(['work', 'chats', 'projects']);
    const up = reorderSectionsByDrop(order, drawn, 'projects', 'chats');
    expect(up.filter((key) => drawn.includes(key))).toEqual(['projects', 'chats', 'work']);
  });

  test('Chats among the projects: moving Chats or a project past it', () => {
    expect(reorderProjectHeadersWithChats(['a', 'zone:chats', 'b'], 'zone:chats', 'zone:chats', 'b'))
      .toEqual({ chatsIndex: 2, projectMove: null });
    expect(reorderProjectHeadersWithChats(['a', 'zone:chats', 'b'], 'zone:chats', 'a', 'zone:chats'))
      .toEqual({ chatsIndex: 0, projectMove: null });
    expect(reorderProjectHeadersWithChats(['zone:chats', 'a', 'b'], 'zone:chats', 'b', 'zone:chats'))
      .toEqual({ chatsIndex: 1, projectMove: { from: 1, to: 0 } });
  });
});
