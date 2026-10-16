import { describe, expect, test } from 'bun:test';
import {
  attentionZonesInUse,
  CLASSIC_SIDEBAR_LAYOUT,
  DEFAULT_SIDEBAR_LAYOUT,
  moveSectionAmongShown,
  normalizeSectionOrder,
  otherAttentionZone,
  placeSection,
  SIDEBAR_SECTION_KEYS,
  sidebarLayoutSchema,
  trackedAttentionZone,
  watchesOtherSessions,
  type SidebarSectionKey,
} from './sidebarLayout';

describe('section order', () => {
  test('completes a stored order, dropping unknown and repeated keys', () => {
    const order = normalizeSectionOrder(['work', 'unknown', 'chats', 'work']);
    expect(order.filter((key) => key === 'work' || key === 'chats')).toEqual(['work', 'chats']);
    expect([...order].sort()).toEqual([...SIDEBAR_SECTION_KEYS].sort());
  });

  test('a section missing from the stored order goes right after its default predecessor', () => {
    const stored = SIDEBAR_SECTION_KEYS.filter((key) => key !== 'stopped');
    const order = normalizeSectionOrder(stored);
    expect(order.indexOf('stopped')).toBe(order.indexOf('errors') + 1);
  });

  test('moving among the shown sections skips the hidden ones', () => {
    const order = normalizeSectionOrder(['chats', 'approvals', 'questions', 'pinned', 'work', 'projects']);
    const shown: readonly SidebarSectionKey[] = ['chats', 'pinned', 'work', 'projects'];
    const moved = moveSectionAmongShown(order, shown, 'work', 'up');
    expect(moved.filter((key) => shown.includes(key))).toEqual(['chats', 'work', 'pinned', 'projects']);
    expect(moveSectionAmongShown(order, shown, 'chats', 'up')).toEqual(order);
  });

  test('placing a section before or after another', () => {
    const order = normalizeSectionOrder(['chats', 'pinned', 'work', 'projects']);
    const before = placeSection(order, 'projects', 'chats', 'before');
    expect(before.indexOf('projects')).toBe(before.indexOf('chats') - 1);
    const after = placeSection(order, 'chats', 'projects', 'after');
    expect(after.indexOf('chats')).toBe(after.indexOf('projects') + 1);
  });
});

describe('stored layout', () => {
  test('completes a partial layout with the defaults and ignores unknown values', () => {
    const parsed = sidebarLayoutSchema.safeParse({ attention: 'combined', afterLeave: 'somewhere', chatsGroupIndex: -2 });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.attention).toBe('combined');
    expect(parsed.data.afterLeave).toBe(DEFAULT_SIDEBAR_LAYOUT.afterLeave);
    expect(parsed.data.chatsGroupIndex).toBe(0);
    expect(parsed.data.sectionOrder).toEqual([...SIDEBAR_SECTION_KEYS]);
  });

  test('anything but an object is not a layout', () => {
    expect(sidebarLayoutSchema.safeParse('classic').success).toBe(false);
    expect(sidebarLayoutSchema.safeParse(null).success).toBe(false);
  });

  test('the default puts Chats between In work and the projects; the classic layout keeps them on top', () => {
    const order = DEFAULT_SIDEBAR_LAYOUT.sectionOrder;
    expect(order.slice(order.indexOf('work'))).toEqual([
      'work', 'other-approvals', 'other-questions', 'other-blocked', 'other-attention', 'other-errors', 'other-stopped', 'other-active', 'chats', 'projects',
    ]);
    expect(CLASSIC_SIDEBAR_LAYOUT.sectionOrder[0]).toBe('chats');
  });

  test('the classic layout pulls nothing and holds nothing', () => {
    expect(attentionZonesInUse(CLASSIC_SIDEBAR_LAYOUT).size).toBe(0);
    expect(CLASSIC_SIDEBAR_LAYOUT.holdOpenSession).toBe(false);
    expect(CLASSIC_SIDEBAR_LAYOUT.afterLeave).toBe('stay');
    expect(CLASSIC_SIDEBAR_LAYOUT.timelineChats).toBe('section');
  });
});

describe('attention zones', () => {
  test('each grouping sends a followed session to its zone', () => {
    const layout = (attention: typeof DEFAULT_SIDEBAR_LAYOUT.attention) => ({ ...DEFAULT_SIDEBAR_LAYOUT, attention });
    expect(trackedAttentionZone(layout('separate'), 'approval')).toBe('approvals');
    expect(trackedAttentionZone(layout('blocked'), 'question')).toBe('blocked');
    expect(trackedAttentionZone(layout('blocked'), 'stopped')).toBe('stopped');
    expect(trackedAttentionZone(layout('combined'), 'error')).toBe('attention');
    expect(trackedAttentionZone(layout('pending'), 'idle')).toBe('pending');
    expect(trackedAttentionZone(layout('pending'), 'running')).toBeNull();
    expect(trackedAttentionZone(layout('off'), 'approval')).toBeNull();
  });

  test('other sessions share the zones, have their own, or stay put, and never move while idle', () => {
    const shared = { ...DEFAULT_SIDEBAR_LAYOUT, attention: 'pending' as const, otherAttention: 'shared' as const };
    expect(otherAttentionZone(shared, 'error')).toBe('pending');
    expect(otherAttentionZone(shared, 'idle')).toBeNull();
    const separate = { ...DEFAULT_SIDEBAR_LAYOUT, otherAttention: 'separate' as const, otherAttentionGrouping: 'blocked' as const };
    expect(otherAttentionZone(separate, 'approval')).toBe('other-blocked');
    expect(otherAttentionZone(DEFAULT_SIDEBAR_LAYOUT, 'approval')).toBeNull();
  });

  test('other sessions are watched only when the layout uses them', () => {
    expect(watchesOtherSessions(DEFAULT_SIDEBAR_LAYOUT)).toBe(false);
    expect(watchesOtherSessions({ ...DEFAULT_SIDEBAR_LAYOUT, otherActive: true })).toBe(true);
    expect(watchesOtherSessions({ ...DEFAULT_SIDEBAR_LAYOUT, attention: 'off', otherAttention: 'shared' })).toBe(false);
  });
});
