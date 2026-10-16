import { updateDesktopSettings } from '@/lib/persistence';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import type { SidebarLayout } from '@/stores/sidebarLayout';

/** Changes part of the sidebar layout here and saves the whole layout for this surface kind. */
export const saveSidebarLayout = (patch: Partial<SidebarLayout>): void => {
  const next: SidebarLayout = { ...useSessionDisplayStore.getState().sidebarLayout, ...patch };
  useSessionDisplayStore.getState().setSidebarLayout(next);
  void updateDesktopSettings({ sidebarLayout: next });
};
