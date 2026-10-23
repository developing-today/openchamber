import React from 'react';
import { formatEffortLabel } from '@/components/chat/mobileControlsUtils';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import {
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsFieldRow,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useCallableModelProviders } from '@/hooks/useCallableModelProviders';
import {
  fetchGoalWriterBuiltinPrompt,
  requestGoalWriterPromptRewrite,
  type GoalWriterBuiltinPromptResult,
} from '@/lib/goalWriter';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { modelVariantNames } from '@/lib/modelVariants';
import { findCatalogModel } from '@/lib/opencode/model';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import { isAutoModel } from '@/lib/routing/autoModel';
import { useConfigStore } from '@/stores/useConfigStore';
import { isDirectoryUnknown, useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore, type SessionGoalAutoCreate, type SessionGoalWriterSendMode } from '@/stores/useUIStore';
import { GoalWriterPromptEditor } from './GoalWriterPromptEditor';

/** The effort picker's value for "no level": the model's own default. */
const MODEL_DEFAULT_EFFORT = '__default__';

/**
 * The goal writer's settings in Settings → Chat → Goal: the composer switch,
 * the model and its effort, remembering a pick made in a goal window, the
 * prompt, review before sending, what the spec does on send, rewriting every
 * goal, and starting a goal from the next message.
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
  const rememberChoice = useUIStore((state) => state.sessionGoalWriterRememberChoice);
  const setRememberChoice = useUIStore((state) => state.setSessionGoalWriterRememberChoice);

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
        checked={rememberChoice}
        onChange={setRememberChoice}
        disabled={disabled}
        label={t('settings.openchamber.visual.goal.writer.rememberLabel')}
        ariaLabel={t('settings.openchamber.visual.goal.writer.rememberAria')}
        info={t('settings.openchamber.visual.goal.writer.rememberInfo')}
        settingsItem="chat.session-goal-writer-remember"
      />
      <SessionGoalWriterPromptField disabled={disabled} />
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
 * Which model writes goal specs, and at which effort. Empty means the model
 * the session uses, named under the label when the composer has one. The
 * server reads the model for every spec it writes, so it lives in the settings
 * file only, as the walkthrough model does; the effort applies only to a
 * model picked here and is cleared when the pick changes.
 */
const SessionGoalWriterModelField: React.FC<{ disabled: boolean }> = ({ disabled }) => {
  const { t } = useI18n();
  // Fail closed: never offer providers whose credentials were not verified.
  const providers = useCallableModelProviders() ?? [];
  const catalog = useConfigStore((state) => state.providers);
  const sessionProviderId = useConfigStore((state) => state.currentProviderId);
  const sessionModelId = useConfigStore((state) => state.currentModelId);
  const variant = useUIStore((state) => state.sessionGoalWriterVariant);
  const setVariant = useUIStore((state) => state.setSessionGoalWriterVariant);
  const [model, setModel] = React.useState<string | undefined>();
  // Until the saved pick is read, an empty pick does not yet mean the session's model.
  const [modelKnown, setModelKnown] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const settings = await loadDesktopSettings();
        if (!alive || !settings) return;
        const stored = settings.sessionGoalWriterModel?.trim();
        if (stored) setModel(stored);
        setModelKnown(true);
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
    setModelKnown(true);
    // An effort level belongs to the model it was picked for.
    setVariant('');
    try {
      // Clearing the picker goes back to the session's model, so an empty
      // value is a real choice.
      await updateDesktopSettings({ sessionGoalWriterModel: next ?? '' });
    } catch (error) {
      console.warn('Failed to save the goal writer model:', error);
    }
  }, [setVariant]);

  const levels = React.useMemo(() => {
    if (!parsed.providerId || !parsed.modelId) return [];
    const provider = catalog.find((entry) => entry.id === parsed.providerId);
    return modelVariantNames(findCatalogModel(provider?.models, parsed.modelId));
  }, [catalog, parsed.modelId, parsed.providerId]);

  const sessionModel = sessionProviderId && sessionModelId ? `${sessionProviderId}/${sessionModelId}` : '';
  // Auto is OpenChamber's own choice and runs on no provider, so on Auto the
  // small model writes specs (small-model resolveSmallModel), and the line says so.
  const sessionOnAuto = isAutoModel(sessionProviderId, sessionModelId);

  return (
    <>
      <SettingsFieldRow
        settingsItem="chat.session-goal-writer-model"
        label={t('settings.openchamber.visual.goal.writer.modelLabel')}
        info={t('settings.openchamber.visual.goal.writer.modelInfo')}
        description={modelKnown && !model && sessionModel
          ? sessionOnAuto
            ? t('settings.openchamber.visual.goal.writer.modelSessionAuto')
            : t('settings.openchamber.visual.goal.writer.modelSessionInUse', { model: sessionModel })
          : undefined}
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
      <SettingsFieldRow
        settingsItem="chat.session-goal-writer-effort"
        label={t('settings.openchamber.visual.goal.writer.effortLabel')}
        info={t('settings.openchamber.visual.goal.writer.effortInfo')}
      >
        <Select
          value={variant || MODEL_DEFAULT_EFFORT}
          onValueChange={(value) => setVariant(value === MODEL_DEFAULT_EFFORT ? '' : value)}
          // A saved level stays clearable even when the model no longer lists it.
          disabled={disabled || (levels.length === 0 && !variant)}
        >
          <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.openchamber.visual.goal.writer.effortLabel')}>
            <SelectValue>
              {variant ? formatEffortLabel(variant) : t('settings.openchamber.visual.goal.writer.effortDefault')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={MODEL_DEFAULT_EFFORT}>{t('settings.openchamber.visual.goal.writer.effortDefault')}</SelectItem>
            {levels.map((level) => (
              <SelectItem key={level} value={level}>{formatEffortLabel(level)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsFieldRow>
    </>
  );
};

/**
 * The goal writer's prompt, saved through the settings store. The server owns
 * the built-in text and the rules after it, so both are read from it.
 */
const SessionGoalWriterPromptField: React.FC<{ disabled: boolean }> = ({ disabled }) => {
  const stored = useUIStore((state) => state.sessionGoalWriterPrompt);
  const setStored = useUIStore((state) => state.setSessionGoalWriterPrompt);
  // The session's model writes specs when Settings names none, so it rewrites the prompt too.
  const providerID = useConfigStore((state) => state.currentProviderId);
  const modelID = useConfigStore((state) => state.currentModelId);
  const [builtin, setBuiltin] = React.useState<GoalWriterBuiltinPromptResult | null>(null);

  React.useEffect(() => {
    let alive = true;
    void fetchGoalWriterBuiltinPrompt().then((result) => {
      if (alive) setBuiltin(result);
    });
    return () => {
      alive = false;
    };
  }, []);

  const rewrite = React.useCallback(
    (prompt: string, instruction: string, signal: AbortSignal) => {
      // The directory the session's model belongs to, read when the user asks;
      // none while the app does not know it yet.
      const directoryState = useDirectoryStore.getState();
      const directory = isDirectoryUnknown(directoryState) ? null : directoryState.currentDirectory || null;
      return requestGoalWriterPromptRewrite({ prompt, instruction, directory, providerID, modelID, signal });
    },
    [modelID, providerID],
  );

  return <GoalWriterPromptEditor stored={stored} onStore={setStored} builtin={builtin} rewrite={rewrite} disabled={disabled} />;
};
