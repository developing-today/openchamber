import { arrayMove } from '@dnd-kit/sortable';
import { placeSection, type SidebarSectionKey } from '@/stores/sidebarLayout';

/**
 * The section order after the header of `activeKey` was dropped on the
 * header of `overKey`: it lands on the far side of that header from where it
 * came, like the sortable list showed while dragging. Sections that are not
 * drawn keep their places.
 */
export const reorderSectionsByDrop = (
  order: readonly SidebarSectionKey[],
  drawnKeys: readonly SidebarSectionKey[],
  activeKey: SidebarSectionKey,
  overKey: SidebarSectionKey,
): SidebarSectionKey[] => {
  const from = drawnKeys.indexOf(activeKey);
  const to = drawnKeys.indexOf(overKey);
  if (from < 0 || to < 0 || from === to) return [...order];
  return placeSection(order, activeKey, overKey, from < to ? 'after' : 'before');
};

/**
 * The List view's project headers with Chats among them, after one of them
 * was dropped on another: where Chats now sits among the projects, and the
 * project move (indexes among the projects alone) when a project moved.
 */
export const reorderProjectHeadersWithChats = (
  headerIds: readonly string[],
  chatsId: string,
  activeId: string,
  overId: string,
): { chatsIndex: number; projectMove: { from: number; to: number } | null } | null => {
  const from = headerIds.indexOf(activeId);
  const to = headerIds.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  const moved = arrayMove([...headerIds], from, to);
  const chatsIndex = moved.indexOf(chatsId);
  if (activeId === chatsId) return { chatsIndex, projectMove: null };
  const projectsBefore = headerIds.filter((id) => id !== chatsId);
  const projectsAfter = moved.filter((id) => id !== chatsId);
  const projectFrom = projectsBefore.indexOf(activeId);
  const projectTo = projectsAfter.indexOf(activeId);
  return { chatsIndex, projectMove: projectFrom === projectTo ? null : { from: projectFrom, to: projectTo } };
};
