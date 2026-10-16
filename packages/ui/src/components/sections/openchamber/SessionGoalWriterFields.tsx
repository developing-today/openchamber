import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import {
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsFieldRow,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useCallableModelProviders } from '@/hooks/useCallableModelProviders';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import { useUIStore, type SessionGoalAutoCreate, type SessionGoalWriterSendMode } from '@/stores/useUIStore';

/**
 * The goal writer's settings in Settings → Chat → Goal: the composer switch,
 * the model, review before sending, what the spec does on send, rewriting
 * every goal, and starting a goal from the next message.
 */
export const SessionGoalWriterFields: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
  const { t } = useI18n();
  const writerEnabled = useUIStore((state) => state.sessionGoalWriterEnabled);
  const setWriterEnabled = useUIStore((state) => state.setSessionGoalWriterEnabled);
  const review = useUIStore((state) => state.sessionGoalWriterReview);
  const setReview = useUIStore((state) => state.setSessionGoalWriterReview);
  const sendMode = useUIStore((state) => state.sessionGoalWriterSendMode);
  const setSendMode = useUIStore((state) => state.setSessionGoalWriterSendMode);
  const rewriteAll = useUIStore((state) => state.sessionGoalRewriteAll);
  const setRewriteAll = useUIStore((state) => state.setSessionGoalRewriteAll);
  const autoCreate = useUIStore((state) => state.sessionGoalAutoCreate);
  const setAutoCreate = useUIStore((state) => state.setSessionGoalAutoCreate);

  return (
    <>
      <SettingsCheckboxRow
        checked={writerEnabled}
        onChange={setWriterEnabled}
        disabled={disabled}
        label={t('settings.openchamber.visual.goal.writer.enabledLabel')}
        ariaLabel={t('settings.openchamber.visual.goal.writer.enabledAria')}
        info={t('settings.openchamber.visual.goal.writer.enabledInfo')}
        settingsItem="chat.session-goal-writer"
      />
      <SessionGoalWriterModelField disabled={disabled} />
      <SettingsCheckboxRow
        checked={review}
        onChange={setReview}
        disabled={disabled}
        label={t('settings.openchamber.visual.goal.writer.reviewLabel')}
        ariaLabel={t('settings.openchamber.visual.goal.writer.reviewAria')}
        info={t('settings.openchamber.visual.goal.writer.reviewInfo')}
        settingsItem="chat.session-goal-writer-review"
      />
      <SettingsFieldRow
        settingsItem="chat.session-goal-writer-send-mode"
        label={t('settings.openchamber.visual.goal.writer.sendModeLabel')}
        info={t('settings.openchamber.visual.goal.writer.sendModeInfo')}
      >
        <SettingsChipGroup<SessionGoalWriterSendMode>
          aria-label={t('settings.openchamber.visual.goal.writer.sendModeLabel')}
          value={sendMode}
          onChange={setSendMode}
          options={[
            { value: 'with-message', label: t('settings.openchamber.visual.goal.writer.sendMode.withMessage'), disabled },
            { value: 'goal-as-message', label: t('settings.openchamber.visual.goal.writer.sendMode.goalAsMessage'), disabled },
          ]}
        />
      </SettingsFieldRow>
      <SettingsCheckboxRow
        checked={rewriteAll}
        onChange={setRewriteAll}
        disabled={disabled}
        label={t('settings.openchamber.visual.goal.writer.rewriteAllLabel')}
        ariaLabel={t('settings.openchamber.visual.goal.writer.rewriteAllAria')}
        info={t('settings.openchamber.visual.goal.writer.rewriteAllInfo')}
        settingsItem="chat.session-goal-rewrite-all"
      />
      <SettingsFieldRow
        settingsItem="chat.session-goal-auto-create"
        label={t('settings.openchamber.visual.goal.autoCreate.label')}
        info={t('settings.openchamber.visual.goal.autoCreate.info')}
      >
        <SettingsChipGroup<SessionGoalAutoCreate>
          aria-label={t('settings.openchamber.visual.goal.autoCreate.label')}
          value={autoCreate}
          onChange={setAutoCreate}
          options={[
            { value: 'off', label: t('settings.openchamber.visual.goal.autoCreate.off'), disabled },
            { value: 'review', label: t('settings.openchamber.visual.goal.autoCreate.review'), disabled },
            { value: 'auto', label: t('settings.openchamber.visual.goal.autoCreate.auto'), disabled },
          ]}
        />
      </SettingsFieldRow>
    </>
  );
};

/**
 * Which model writes goal specs. Empty means the model the session uses. The
 * server reads the setting for every spec it writes, so the value lives in the
 * settings file only, as the walkthrough model does.
 */
const SessionGoalWriterModelField: React.FC<{ disabled: boolean }> = ({ disabled }) => {
  const { t } = useI18n();
  // Fail closed: never offer providers whose credentials were not verified.
  const providers = useCallableModelProviders() ?? [];
  const [model, setModel] = React.useState<string | undefined>();

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const stored = (await loadDesktopSettings())?.sessionGoalWriterModel?.trim();
        if (alive && stored) setModel(stored);
      } catch (error) {
        console.warn('Failed to load the goal writer model:', error);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);

  const parsed = parseModelIdentifier(model) ?? { providerId: '', modelId: '' };

  const handleChange = React.useCallback(async (providerId: string, modelId: string) => {
    const next = providerId && modelId ? `${providerId}/${modelId}` : undefined;
    setModel(next);
    try {
      // Clearing the picker goes back to the session's model, so an empty
      // value is a real choice.
      await updateDesktopSettings({ sessionGoalWriterModel: next ?? '' });
    } catch (error) {
      console.warn('Failed to save the goal writer model:', error);
    }
  }, []);

  return (
    <SettingsFieldRow
      settingsItem="chat.session-goal-writer-model"
      label={t('settings.openchamber.visual.goal.writer.modelLabel')}
      info={t('settings.openchamber.visual.goal.writer.modelInfo')}
    >
      <div className={cn(disabled && 'pointer-events-none opacity-50')} aria-disabled={disabled || undefined}>
        <ModelSelector
          providerId={parsed.providerId}
          modelId={parsed.modelId}
          onChange={(providerId, modelId) => {
            void handleChange(providerId, modelId);
          }}
          allowedProviderIds={providers}
          placeholder={t('settings.openchamber.visual.goal.writer.modelSessionDefault')}
          className={SETTINGS_CUSTOM_TRIGGER_CLASS}
        />
      </div>
    </SettingsFieldRow>
  );
};
