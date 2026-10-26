import React from 'react';
import { toast } from '@/components/ui';
import { Checkbox } from '@/components/ui/checkbox';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { SubagentPolicy } from '@/lib/opencode/model';
import {
    splitSubagentPolicyModels,
    toggleSubagentModel,
} from '@/lib/opencode/subagentPolicy';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSubsessionDraftStore } from '@/stores/useSubsessionDraftStore';
import { useSessionSelector } from '@/sync/sync-context';
import { updateSessionSubagentPolicy } from '@/sync/session-actions';
import { cn } from '@/lib/utils';

interface SubsessionModelsControlProps {
    sessionId: string | null;
    directory?: string;
    /** A new-session draft is open: the selection is held for its create call. */
    draftOpen?: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    withTooltip?: boolean;
}

const selectSessionPolicy = (session: { subagentPolicy?: SubagentPolicy } | undefined) => session?.subagentPolicy;

/**
 * "Subsession models" picker, beside the composer's model picker.
 *
 * On a session it shows the session's `subagentPolicy.models`: one checkbox
 * per model in the same catalog the model picker reads, grouped by provider
 * the same way. Route pools (`opencode-route/<pool-id>`) are ordinary
 * catalog entries, so they are selectable like any other exact ref; pool
 * management lives on its own surface, not here. Toggling a checkbox PATCHes the session with the whole
 * updated policy, preserving `excludedModels` and `agentOverrides` as
 * loaded, and the checked state then comes from the re-read session record.
 * Policy entries that are not exact refs (`provider/*`,
 * `provider/model#variant`) were set through config or the API: they show
 * as read-only rows and are preserved verbatim on save.
 *
 * In a new-session draft there is no session to PATCH, so the selection is
 * held in `useSubsessionDraftStore` and sent as `subagentPolicy` on create.
 */
export const SubsessionModelsControl: React.FC<SubsessionModelsControlProps> = React.memo(({
    sessionId,
    directory,
    draftOpen = false,
    footerIconButtonClass,
    iconSizeClass,
    withTooltip = false,
}) => {
    const { t } = useI18n();
    const providers = useConfigStore((state) => state.providers);
    const hiddenModels = useUIStore((state) => state.hiddenModels);
    const draftModels = useSubsessionDraftStore((state) => state.models);
    const setDraftModels = useSubsessionDraftStore((state) => state.setModels);
    const policy = useSessionSelector(sessionId ?? undefined, directory, selectSessionPolicy);
    const [saving, setSaving] = React.useState(false);

    const isDraft = draftOpen && !sessionId;

    const visibleProviders = React.useMemo(() => {
        const result: typeof providers = [];
        for (const provider of providers) {
            const models = (Array.isArray(provider.models) ? provider.models : []).filter((model) => (
                !hiddenModels.some((item) => item.providerID === provider.id && item.modelID === model.id)
            ));
            if (models.length > 0) result.push({ ...provider, models });
        }
        return result;
    }, [providers, hiddenModels]);

    if (!isDraft && !sessionId) return null;

    const { exact, readOnly } = isDraft
        ? { exact: draftModels, readOnly: [] }
        : splitSubagentPolicyModels(policy);
    const checkedCount = exact.length + readOnly.length;

    const handleToggle = (ref: string, checked: boolean) => {
        if (isDraft) {
            setDraftModels(toggleSubagentModel({ models: draftModels }, ref, checked).models ?? []);
            return;
        }
        if (!sessionId || saving) return;
        const next = toggleSubagentModel(policy, ref, checked);
        setSaving(true);
        updateSessionSubagentPolicy(sessionId, directory, next)
            .catch((error) => {
                console.error('[SubsessionModelsControl] Failed to update subsession models:', error);
                toast.error(t('chat.subsessionModels.saveFailed'));
            })
            .finally(() => setSaving(false));
    };

    const label = t('chat.subsessionModels.button');
    const button = (
        <button
            type="button"
            className={footerIconButtonClass}
            aria-label={label}
            aria-pressed={checkedCount > 0}
            {...(withTooltip ? {} : { title: label })}
        >
            <Icon name="node-tree" className={cn(iconSizeClass, 'text-current')} aria-hidden="true" />
        </button>
    );

    return (
        <DropdownMenu>
            {withTooltip ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                </Tooltip>
            ) : (
                <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
            )}
            <DropdownMenuContent align="start" side="top" className="w-72 p-0">
                <DropdownMenuLabel className="px-3 pt-3 pb-1">
                    {t('chat.subsessionModels.title')}
                </DropdownMenuLabel>
                <p className="px-3 pb-2 typography-meta text-muted-foreground">
                    {t('chat.subsessionModels.hint')}
                </p>
                <ScrollableOverlay outerClassName="max-h-64">
                    <div className="px-1.5 pb-2">
                        {readOnly.map((selector) => (
                            <div
                                key={selector}
                                className="flex items-center gap-2 rounded px-1.5 py-1.5"
                                title={t('chat.subsessionModels.readOnly')}
                            >
                                <Checkbox checked disabled onChange={() => undefined} ariaLabel={selector} />
                                <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">{selector}</span>
                                <span className="shrink-0 typography-micro text-muted-foreground">
                                    {t('chat.subsessionModels.readOnly')}
                                </span>
                            </div>
                        ))}
                        {visibleProviders.map((provider) => (
                            <div key={provider.id}>
                                <div className="px-1.5 pt-2 pb-0.5 typography-micro text-muted-foreground">
                                    {provider.name || provider.id}
                                </div>
                                {provider.models.map((model) => {
                                    const ref = `${provider.id}/${model.id}`;
                                    const isChecked = exact.includes(ref);
                                    return (
                                        <div
                                            key={ref}
                                            className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 hover:bg-[var(--interactive-hover)]"
                                            onClick={() => handleToggle(ref, !isChecked)}
                                        >
                                            <Checkbox
                                                checked={isChecked}
                                                disabled={saving}
                                                onChange={(checked) => handleToggle(ref, checked)}
                                                ariaLabel={ref}
                                            />
                                            <span className="min-w-0 flex-1 truncate typography-meta">
                                                {model.name || model.id}
                                            </span>
                                            <span className="shrink-0 typography-micro text-muted-foreground">{ref}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                        {visibleProviders.length === 0 && readOnly.length === 0 ? (
                            <p className="px-1.5 py-2 typography-meta text-muted-foreground">
                                {t('chat.subsessionModels.empty')}
                            </p>
                        ) : null}
                    </div>
                </ScrollableOverlay>
            </DropdownMenuContent>
        </DropdownMenu>
    );
});
