import React from 'react';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { formatCompactNumber } from '@/lib/numberFormat';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

const formatTokens = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  if (value === 0) {
    return '0';
  }
  const formatted = formatCompactNumber(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

/** A model row: the id its show and hide choice is stored under, and the name it shows. */
interface ProviderModelRow {
  id: string;
  name: string;
}

interface ProviderModelsSectionProps {
  providerId: string;
  models: readonly ProviderModelRow[];
  title: string;
  info?: string;
  /** The filter text, kept by the page across the providers it shows. */
  query: string;
  onQueryChange: (query: string) => void;
}

/**
 * A provider's models with their show and hide switches, which decide what
 * the model selectors offer. The page passes the models OpenCode lists or,
 * for a turned-off provider OpenCode no longer lists, the ones its OpenCode
 * config entry names.
 */
export const ProviderModelsSection: React.FC<ProviderModelsSectionProps> = ({ providerId, models, title, info, query, onQueryChange }) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const hideAllModels = useUIStore((state) => state.hideAllModels);
  const showAllModels = useUIStore((state) => state.showAllModels);

  const filteredModels = rankByQuery(models, query, (model) => [model.name, model.id]);

  return (
    <SettingsSection
      title={title}
      info={info}
      titleAccessory={
        <span className="typography-micro text-muted-foreground font-normal">
          ({models.length})
        </span>
      }
      headerAction={(
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={() => hideAllModels(providerId, models.map((model) => model.id).filter((id) => id.length > 0))}
          >
            {t('settings.providers.page.actions.hideAll')}
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="!font-normal"
            onClick={() => showAllModels(providerId)}
          >
            {t('settings.providers.page.actions.showAll')}
          </Button>
        </div>
      )}
      settingsItem="providers.models"
    >
      <div className="relative mb-2">
        <Icon name="search" className="absolute inset-s-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('settings.providers.page.models.filterPlaceholder')}
          className="h-7 ps-8 w-full"
        />
      </div>

      {filteredModels.length === 0 ? (
        <p className="typography-meta text-muted-foreground py-4 text-center">{t('settings.providers.page.models.noModelsMatchFilter')}</p>
      ) : (
        <div className="divide-y divide-[var(--surface-subtle)]">
          {filteredModels.map((model) => {
            const modelName = model.name || model.id;
            const metadata = model.id ? getModelMetadata(providerId, model.id) : undefined;
            const isHidden = hiddenModels.some(
              (item) => item.providerID === providerId && item.modelID === model.id
            );

            const contextTokens = formatTokens(metadata?.limit?.context);
            const outputTokens = formatTokens(metadata?.limit?.output);
            const tokenSummary = [
              contextTokens ? `${contextTokens} ${t('settings.providers.page.models.tokenBadge.context')}` : null,
              outputTokens ? `${outputTokens} ${t('settings.providers.page.models.tokenBadge.output')}` : null,
            ].filter(Boolean).join(' · ');

            const capabilityIcons: Array<{ key: string; icon: IconName; label: string }> = [];
            if (metadata?.tool_call) capabilityIcons.push({ key: 'tools', icon: "tools", label: t('settings.providers.page.models.capability.toolCalling') });
            if (metadata?.reasoning) capabilityIcons.push({ key: 'reasoning', icon: "brain-ai-3", label: t('settings.providers.page.models.capability.reasoning') });
            if (metadata?.attachment) capabilityIcons.push({ key: 'image', icon: "file-image", label: t('settings.providers.page.models.capability.imageInput') });

            return (
              <div key={model.id} className="py-1.5">
                <div className={cn("flex items-center gap-3", isHidden && 'opacity-50')}>
                  <span className="typography-meta font-medium text-foreground truncate flex-1 min-w-0">
                    {modelName}
                  </span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {isMobile ? (
                      // A phone row has room for the name only; the limits
                      // and capabilities move behind a tap.
                      (tokenSummary || capabilityIcons.length > 0) ? (
                        <SettingsInfoHint className="h-6 w-6">
                          <div className="space-y-1.5">
                            {tokenSummary ? <div className="font-medium">{tokenSummary}</div> : null}
                            {capabilityIcons.map(({ key, icon: iconName, label }) => (
                              <div key={key} className="flex items-center gap-1.5">
                                <Icon name={iconName} className="h-3.5 w-3.5" />
                                {label}
                              </div>
                            ))}
                          </div>
                        </SettingsInfoHint>
                      ) : null
                    ) : (
                      <>
                        {tokenSummary ? (
                          <span className="typography-micro text-muted-foreground flex-shrink-0 oc-tile-inset px-1.5 py-0.5 rounded">
                            {tokenSummary}
                          </span>
                        ) : null}
                        {capabilityIcons.length > 0 && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {capabilityIcons.map(({ key, icon: iconName, label }) => (
                              <span
                                key={key}
                                className="flex h-5 w-5 rounded items-center justify-center text-muted-foreground oc-tile-inset"
                                title={label}
                                aria-label={label}
                              >
                                <Icon name={iconName} className="h-3 w-3" />
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => toggleHiddenModel(providerId, model.id)}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]/50"
                      title={isHidden ? t('settings.providers.page.models.actions.showModelInSelectors') : t('settings.providers.page.models.actions.hideModelFromSelectors')}
                      aria-label={isHidden ? t('settings.providers.page.models.actions.showModel') : t('settings.providers.page.models.actions.hideModel')}
                    >
                      {isHidden ? <Icon name="eye-off" className="h-3.5 w-3.5" /> : <Icon name="eye" className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
};
