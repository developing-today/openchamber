import { toast } from '@/components/ui';
import { useKeybind } from '@/hooks/useKeybind';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { SessionSidebarRowModel } from '../sessionSidebarRowModel';
import { resolveNextAttentionEntry } from './nextAttentionSession';
import { isAttentionContainer } from './useSessionLeavePlanner';

type NextAttentionInputs = {
  rowModel: SessionSidebarRowModel;
  onOpen: (sessionId: string, directory: string | null) => void;
};

/**
 * The "next session that needs attention" shortcut, registered while the
 * desktop sidebar is mounted because the target comes from the rows as drawn.
 * VS Code keeps the classic layout and registers nothing, like the leave
 * planner. When nothing needs attention the shortcut says so instead of
 * silently doing nothing.
 */
export const useNextAttentionSession = (enabled: boolean, inputs: NextAttentionInputs): void => {
  const { t } = useI18n();
  useKeybind('open_next_attention_session', () => {
    if (!enabled) return false;
    const target = resolveNextAttentionEntry(
      inputs.rowModel.navigationEntries,
      useSessionUIStore.getState().currentSessionId,
      isAttentionContainer,
    );
    if (!target) {
      toast.info(t('sessions.sidebar.attention.noneNeedsAttention'));
      return;
    }
    inputs.onOpen(target.sessionId, target.directory);
  });
};
