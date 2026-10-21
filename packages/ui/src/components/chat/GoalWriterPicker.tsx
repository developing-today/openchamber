import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useCallableModelProviders } from '@/hooks/useCallableModelProviders';
import type { GoalWriterChoice } from '@/lib/goalWriter';
import { useI18n } from '@/lib/i18n';
import { modelVariantNames } from '@/lib/modelVariants';
import { updateDesktopSettings } from '@/lib/persistence';
import { useGoalWriterDefault } from '@/hooks/useGoalWriterDefault';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

const DEFAULT_EFFORT = '__default__';

const formatEffort = (variant: string): string => variant.charAt(0).toUpperCase() + variant.slice(1);

/** Saves a writer choice as the Settings default; rejects when the write did not land. */
const rememberGoalWriterChoice = async (choice: GoalWriterChoice): Promise<void> => {
  const result = await updateDesktopSettings({
    sessionGoalWriterModel: `${choice.providerID}/${choice.modelID}`,
    // Empty clears it: the model then writes at its default effort.
    sessionGoalWriterVariant: choice.variant ?? '',
  });
  if (!result.ok) throw new Error('The goal writer model was not saved');
};

interface GoalWriterPickerProps {
  directory?: string | null;
  /** The model the session works with; it writes when Settings name no writer model. */
  sessionModel: { providerID: string; modelID: string } | null;
  /** A choice made in this window, or null to keep the default. */
  value: GoalWriterChoice | null;
  onChange: (value: GoalWriterChoice) => void;
  disabled?: boolean;
}

/**
 * Which model, at which effort, writes this goal spec. It starts on the
 * default (the Settings writer model, else the session's model); a change
 * applies to this window only unless the user remembers it, or Settings say
 * to remember every choice.
 */
export function GoalWriterPicker({ directory, sessionModel, value, onChange, disabled = false }: GoalWriterPickerProps) {
  const { t } = useI18n();
  const writerDefault = useGoalWriterDefault();
  const rememberAlways = useUIStore((state) => state.sessionGoalWriterRememberChoice);
  // Fail closed: never offer providers whose credentials were not verified.
  const allowedProviders = useCallableModelProviders() ?? [];
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, directory ?? undefined));
  const [remembered, setRemembered] = React.useState(false);

  const shown: GoalWriterChoice | null = value
    ?? writerDefault
    ?? (sessionModel ? { ...sessionModel, variant: null } : null);

  const efforts = React.useMemo(() => {
    if (!shown) return [];
    const model = providers.find((provider) => provider.id === shown.providerID)?.models.find((entry) => entry.id === shown.modelID);
    return modelVariantNames(model);
  }, [providers, shown]);

  const change = (next: GoalWriterChoice) => {
    setRemembered(false);
    onChange(next);
    if (rememberAlways) {
      void rememberGoalWriterChoice(next).catch((error) => console.warn('Failed to save the goal writer model:', error));
    }
  };

  const remember = () => {
    if (!value) return;
    void rememberGoalWriterChoice(value)
      .then(() => setRemembered(true))
      .catch((error) => console.warn('Failed to save the goal writer model:', error));
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" aria-disabled={disabled || undefined}>
      <span className="typography-meta text-muted-foreground">{t('chat.goal.writer.picker.label')}</span>
      <ModelSelector
        directory={directory ?? undefined}
        providerId={shown?.providerID ?? ''}
        modelId={shown?.modelID ?? ''}
        onChange={(providerID, modelID) => {
          if (providerID && modelID) change({ providerID, modelID, variant: null });
        }}
        allowedProviderIds={allowedProviders}
        placeholder={t('settings.openchamber.visual.goal.writer.modelSessionDefault')}
        className="max-w-[16rem]"
      />
      {efforts.length > 0 && shown ? (
        <Select
          value={shown.variant ?? DEFAULT_EFFORT}
          onValueChange={(next) => change({ ...shown, variant: next === DEFAULT_EFFORT ? null : next })}
          disabled={disabled}
        >
          <SelectTrigger aria-label={t('chat.goal.writer.picker.effortAria')} className="w-fit">
            <SelectValue>{shown.variant ? formatEffort(shown.variant) : t('chat.goal.writer.picker.effortDefault')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_EFFORT}>{t('chat.goal.writer.picker.effortDefault')}</SelectItem>
            {efforts.map((effort) => (
              <SelectItem key={effort} value={effort}>{formatEffort(effort)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {value && !rememberAlways ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || remembered}
          onClick={remember}
          title={t('chat.goal.writer.picker.rememberHint')}
        >
          {remembered ? t('chat.goal.writer.picker.remembered') : t('chat.goal.writer.picker.remember')}
        </Button>
      ) : null}
    </div>
  );
}
