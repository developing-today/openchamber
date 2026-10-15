import React from 'react';
import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';

/** The same switch the new-session draft shows next to its branch selector. */
export const AutoCreateWorktreeSettings: React.FC = () => {
  const { t } = useI18n();
  const enabled = useConfigStore((state) => state.settingsAutoCreateWorktree);
  const setEnabled = useConfigStore((state) => state.setSettingsAutoCreateWorktree);

  return (
    <SettingsSection title={t('settings.openchamber.autoCreateWorktree.title')}>
      <SettingsCheckboxRow
        settingsItem="sessions.auto-create-worktree"
        checked={enabled}
        onChange={setEnabled}
        label={t('settings.openchamber.autoCreateWorktree.field.enable')}
        info={t('settings.openchamber.autoCreateWorktree.field.enableInfo')}
      />
    </SettingsSection>
  );
};
