import React from 'react';

import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
  SettingsStackedField,
  SettingsTwoColumn,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MATCH_LABEL_KEYS } from '@/components/messaging/messagingLabels';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { MessagingConfig, MessagingEmbeddingConfig, MessagingRemoteConfig } from '@/lib/messagingConfigApi';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { formatCompactNumber } from '@/lib/numberFormat';
import { MESSAGING_DELIVERIES, MESSAGING_MATCH_MODES, type MessagingDelivery, type MessagingMatchMode, type MessagingModelStatus, type MessagingVar } from '@/lib/opencode/messaging';
import { cn } from '@/lib/utils';
import { getMessagingSettingsScope, useMessagingSettingsStore } from '@/stores/useMessagingSettingsStore';
import { useMessagingStore } from '@/stores/useMessagingStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Settings → Messaging: the `messaging` section of OpenCode's config. The
 * local embedding model (which size, a model of your own, starting it now), a
 * remote embeddings endpoint, search defaults, how messages reach sessions,
 * the line every session starts with, and the topic presets, constants and
 * global variables templates use.
 */

/** OpenCode's built-in start line, shown as the template field's placeholder. */
const DEFAULT_SESSION_START = 'Session started {session_start} ({system_time_zone}). Session ID: {session_id}.{session_lineage}';
/** How often the page re-reads the model while it downloads or starts. */
const MODEL_POLL_MS = 2_000;

const DELIVERY_LABEL_KEYS = {
  none: 'settings.messaging.delivery.none',
  inbox: 'settings.messaging.delivery.inbox',
  wake: 'settings.messaging.delivery.wake',
} as const satisfies Record<MessagingDelivery, I18nKey>;

type UserDelivery = 'hidden' | 'visible' | 'wake';
const USER_DELIVERIES: readonly UserDelivery[] = ['hidden', 'visible', 'wake'];
const USER_DELIVERY_LABEL_KEYS = {
  hidden: 'settings.messaging.delivery.userHidden',
  visible: 'settings.messaging.delivery.userVisible',
  wake: 'settings.messaging.delivery.userWake',
} as const satisfies Record<UserDelivery, I18nKey>;

/** OpenCode names its tiers; an unknown one reads as the default. */
const tierLabelKey = (tier: string): I18nKey => {
  switch (tier) {
    case 'tiny':
      return 'settings.messaging.model.tier.tiny';
    case 'step-up':
      return 'settings.messaging.model.tier.stepUp';
    case 'top':
      return 'settings.messaging.model.tier.top';
    default:
      return 'settings.messaging.model.tier.default';
  }
};

/** A text field that saves when it loses focus or on Enter, so typing does not write the file on every key. */
const CommitInput: React.FC<{
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  type?: 'text' | 'password' | 'number';
  className?: string;
  disabled?: boolean;
}> = ({ value, onCommit, placeholder, ariaLabel, type = 'text', className, disabled }) => {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <Input
      type={type}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={cn('h-8 min-w-0 flex-1 rounded-md px-3', className)}
    />
  );
};

const byteSize = (bytes: number): string => `${formatCompactNumber(bytes / 1_000_000)} MB`;

/** One line saying what the model is doing, in the reserved status slot. */
const modelStatusText = (status: MessagingModelStatus, t: ReturnType<typeof useI18n>['t']): string => {
  const model = status.model ?? status.tier ?? '';
  switch (status.state) {
    case 'off':
      return t('settings.messaging.model.state.off');
    case 'unavailable':
      return t('settings.messaging.model.state.unavailable', { reason: status.error ?? model });
    case 'pending':
      return t('settings.messaging.model.state.pending');
    case 'downloading':
      return t('settings.messaging.model.state.downloading', { model });
    case 'starting':
      return t('settings.messaging.model.state.starting', { model });
    case 'ready':
      return t('settings.messaging.model.state.ready', { model });
    case 'error':
      return t('settings.messaging.model.state.error', { error: status.error ?? '' });
  }
};

const ModelSection: React.FC<{ config: MessagingConfig; locked: boolean; onChange: (change: (config: MessagingConfig) => MessagingConfig) => void }> = ({ config, locked, onChange }) => {
  const { t } = useI18n();
  const model = useMessagingSettingsStore((state) => state.model);
  const loadModel = useMessagingSettingsStore((state) => state.loadModel);
  const startModel = useMessagingSettingsStore((state) => state.startModel);
  const applyTier = useMessagingSettingsStore((state) => state.applyTier);
  const embedding = config.embedding ?? {};
  const status = model.status;
  const active = status?.state === 'downloading' || status?.state === 'starting';

  React.useEffect(() => {
    void loadModel();
  }, [loadModel]);
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void loadModel(), MODEL_POLL_MS);
    return () => clearInterval(timer);
  }, [active, loadModel]);

  // Fields set to undefined drop out when the section is written as JSON.
  const setEmbedding = (change: Partial<MessagingEmbeddingConfig>) =>
    onChange((current) => ({ ...current, embedding: { ...(current.embedding ?? {}), ...change } }));

  const chooseTier = (tier: string) => {
    // A tier replaces a configured file or link, as OpenCode does when it applies one.
    setEmbedding({ tier, url: undefined, path: undefined });
    void applyTier(tier);
  };

  const selectedTier = embedding.url || embedding.path ? null : embedding.tier ?? 'default';
  const received = status?.progress.reduce((sum, item) => sum + item.received, 0) ?? 0;
  const total = status?.progress.every((item) => item.total !== undefined)
    ? status.progress.reduce((sum, item) => sum + (item.total ?? 0), 0)
    : undefined;

  return (
    <SettingsSection title={t('settings.messaging.section.model')} info={t('settings.messaging.section.modelInfo')} divider={false} settingsItem="messaging.model">
      <div className="space-y-5">
        <div className="space-y-1">
          <p className="typography-ui-label text-foreground">{status ? modelStatusText(status, t) : t('settings.messaging.state.loading')}</p>
          {status?.state === 'downloading' ? (
            <div className="max-w-[24rem] space-y-1">
              <div className="h-1.5 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]">
                <div className="h-full rounded-full bg-[var(--primary)] transition-[width]" style={{ width: total ? `${Math.min(100, (received / total) * 100)}%` : '10%' }} />
              </div>
              <p className={SETTINGS_HELPER_CLASS}>
                {total ? t('settings.messaging.model.progress', { received: byteSize(received), total: byteSize(total) }) : t('settings.messaging.model.progressUnknown', { received: byteSize(received) })}
              </p>
            </div>
          ) : null}
          {status?.remote && status.state !== 'ready' ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.messaging.model.remoteInUse')}</p> : null}
          {status?.indexed !== undefined ? (
            <p className={SETTINGS_HELPER_CLASS}>
              {t('settings.messaging.model.indexed', { indexed: formatCompactNumber(status.indexed), pending: formatCompactNumber(status.pending ?? 0) })}
            </p>
          ) : null}
          {model.error ? <p className="typography-meta text-[var(--status-error)]">{t('settings.messaging.model.statusFailed', { error: model.error })}</p> : null}
          {status && (status.state === 'pending' || status.state === 'error') ? (
            <Button type="button" variant="outline" size="sm" className="mt-1" disabled={model.starting} onClick={() => void startModel()}>
              {t('settings.messaging.model.start')}
            </Button>
          ) : null}
        </div>

        <SettingsRadioGroup aria-label={t('settings.messaging.model.tier')}>
          {(status?.tiers ?? []).map((tier) => (
            <SettingsRadioOption
              key={tier.name}
              selected={selectedTier === tier.name}
              disabled={locked || !tier.available}
              onSelect={() => chooseTier(tier.name)}
              label={`${t(tierLabelKey(tier.name))}: ${tier.model}`}
              description={tier.available
                ? t('settings.messaging.model.tierDescription', { size: tier.size, hardware: tier.hardware })
                : t('settings.messaging.model.tierUnavailable', { size: tier.size })}
            />
          ))}
          <SettingsRadioOption
            selected={selectedTier === 'off'}
            disabled={locked}
            onSelect={() => chooseTier('off')}
            label={t('settings.messaging.model.tier.off')}
            description={t('settings.messaging.model.tierOffDescription')}
          />
        </SettingsRadioGroup>

        <SettingsCheckboxRow
          checked={embedding.autostart !== false}
          disabled={locked}
          onChange={(checked) => setEmbedding({ autostart: checked ? undefined : false })}
          label={t('settings.messaging.model.autostart')}
          settingsItem="messaging.autostart"
        />

        <SettingsTwoColumn>
          <SettingsStackedField label={t('settings.messaging.model.url')} info={t('settings.messaging.model.customInfo')}>
            <CommitInput
              value={embedding.url ?? ''}
              disabled={locked}
              placeholder="https://…/model.gguf"
              ariaLabel={t('settings.messaging.model.url')}
              onCommit={(url) => setEmbedding({ url: url || undefined })}
            />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.messaging.model.path')}>
            <CommitInput
              value={embedding.path ?? ''}
              disabled={locked}
              placeholder="/path/to/model.gguf"
              ariaLabel={t('settings.messaging.model.path')}
              onCommit={(path) => setEmbedding({ path: path || undefined })}
            />
          </SettingsStackedField>
        </SettingsTwoColumn>
      </div>
    </SettingsSection>
  );
};

const RemoteSection: React.FC<{ config: MessagingConfig; locked: boolean; onChange: (change: (config: MessagingConfig) => MessagingConfig) => void }> = ({ config, locked, onChange }) => {
  const { t } = useI18n();
  const remote = config.embedding?.remote;
  const [draft, setDraft] = React.useState<{ url: string; model: string }>({ url: remote?.url ?? '', model: remote?.model ?? '' });
  React.useEffect(() => setDraft({ url: remote?.url ?? '', model: remote?.model ?? '' }), [remote?.model, remote?.url]);

  const setRemote = (next: MessagingRemoteConfig | undefined) =>
    onChange((current) => ({ ...current, embedding: { ...(current.embedding ?? {}), remote: next } }));

  // OpenCode needs both a URL and a model; until both are typed, nothing is written.
  const commitEndpoint = (change: Partial<{ url: string; model: string }>) => {
    const next = { ...draft, ...change };
    setDraft(next);
    if (!next.url.trim() || !next.model.trim()) return;
    if (next.url === remote?.url && next.model === remote?.model) return;
    setRemote({ ...(remote ?? {}), url: next.url.trim(), model: next.model.trim() });
  };

  return (
    <SettingsSection title={t('settings.messaging.section.remote')} info={t('settings.messaging.section.remoteInfo')} settingsItem="messaging.remote">
      <div className="space-y-4">
        <SettingsTwoColumn>
          <SettingsStackedField label={t('settings.messaging.remote.url')}>
            <CommitInput value={draft.url} disabled={locked} placeholder="https://api.openai.com/v1" ariaLabel={t('settings.messaging.remote.url')} onCommit={(url) => commitEndpoint({ url })} />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.messaging.remote.model')}>
            <CommitInput value={draft.model} disabled={locked} placeholder="text-embedding-3-small" ariaLabel={t('settings.messaging.remote.model')} onCommit={(model) => commitEndpoint({ model })} />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.messaging.remote.key')} info={t('settings.messaging.remote.keyInfo')}>
            <CommitInput
              type="password"
              value={remote?.key ?? ''}
              disabled={locked || !remote}
              placeholder="{env:OPENAI_API_KEY}"
              ariaLabel={t('settings.messaging.remote.key')}
              onCommit={(key) => remote && setRemote({ ...remote, key: key || undefined })}
            />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.messaging.remote.dimensions')}>
            <CommitInput
              type="number"
              value={remote?.dimensions === undefined ? '' : String(remote.dimensions)}
              disabled={locked || !remote}
              ariaLabel={t('settings.messaging.remote.dimensions')}
              onCommit={(value) => {
                const dimensions = Number.parseInt(value, 10);
                if (remote) setRemote({ ...remote, dimensions: Number.isFinite(dimensions) && dimensions > 0 ? dimensions : undefined });
              }}
            />
          </SettingsStackedField>
        </SettingsTwoColumn>
        {remote ? (
          <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => setRemote(undefined)}>
            {t('settings.messaging.remote.clear')}
          </Button>
        ) : null}
      </div>
    </SettingsSection>
  );
};

const SearchSection: React.FC<{ config: MessagingConfig; locked: boolean; onChange: (change: (config: MessagingConfig) => MessagingConfig) => void }> = ({ config, locked, onChange }) => {
  const { t } = useI18n();
  const match = config.search?.match ?? 'hybrid';
  const parsed = parseModelIdentifier(config.search?.model) ?? { providerId: '', modelId: '' };
  const setSearch = (change: { match?: MessagingMatchMode; model?: string }) =>
    onChange((current) => ({ ...current, search: { ...(current.search ?? {}), ...change } }));

  return (
    <SettingsSection title={t('settings.messaging.section.search')} settingsItem="messaging.search">
      <div className="space-y-4">
        <SettingsFieldRow label={t('settings.messaging.search.match')} info={t('settings.messaging.search.matchInfo')}>
          <Select value={match} disabled={locked} onValueChange={(value) => setSearch({ match: MESSAGING_MATCH_MODES.find((mode) => mode === value) ?? 'hybrid' })}>
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.messaging.search.match')}>
              <SelectValue>{t(MATCH_LABEL_KEYS[match])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MESSAGING_MATCH_MODES.map((mode) => <SelectItem key={mode} value={mode}>{t(MATCH_LABEL_KEYS[mode])}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.messaging.search.model')} info={t('settings.messaging.search.modelInfo')}>
          <div className={cn(locked && 'pointer-events-none opacity-50')} aria-disabled={locked || undefined}>
            <ModelSelector
              providerId={parsed.providerId}
              modelId={parsed.modelId}
              onChange={(providerId, modelId) => setSearch({ model: providerId && modelId ? `${providerId}/${modelId}` : undefined })}
              placeholder={t('settings.messaging.search.modelDefault')}
              className={SETTINGS_CUSTOM_TRIGGER_CLASS}
            />
          </div>
        </SettingsFieldRow>
      </div>
    </SettingsSection>
  );
};

const DeliverySelect: React.FC<{ label: string; value: MessagingDelivery; disabled: boolean; onChange: (value: MessagingDelivery) => void }> = ({ label, value, disabled, onChange }) => {
  const { t } = useI18n();
  return (
    <SettingsFieldRow label={label}>
      <Select value={value} disabled={disabled} onValueChange={(next) => onChange(MESSAGING_DELIVERIES.find((item) => item === next) ?? value)}>
        <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={label}>
          <SelectValue>{t(DELIVERY_LABEL_KEYS[value])}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {MESSAGING_DELIVERIES.map((item) => <SelectItem key={item} value={item}>{t(DELIVERY_LABEL_KEYS[item])}</SelectItem>)}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
};

const DeliverySection: React.FC<{ config: MessagingConfig; locked: boolean; onChange: (change: (config: MessagingConfig) => MessagingConfig) => void }> = ({ config, locked, onChange }) => {
  const { t } = useI18n();
  const delivery = config.delivery ?? {};
  const user = delivery.user ?? 'visible';
  const setDelivery = (change: Partial<NonNullable<MessagingConfig['delivery']>>) =>
    onChange((current) => ({ ...current, delivery: { ...(current.delivery ?? {}), ...change } }));

  return (
    <SettingsSection title={t('settings.messaging.section.delivery')} info={t('settings.messaging.section.deliveryInfo')} settingsItem="messaging.delivery">
      <div className="space-y-4">
        <DeliverySelect label={t('settings.messaging.delivery.direct')} value={delivery.direct ?? 'wake'} disabled={locked} onChange={(direct) => setDelivery({ direct })} />
        <DeliverySelect label={t('settings.messaging.delivery.root')} value={delivery.root ?? 'wake'} disabled={locked} onChange={(root) => setDelivery({ root })} />
        <SettingsFieldRow label={t('settings.messaging.delivery.user')}>
          <Select value={user} disabled={locked} onValueChange={(next) => setDelivery({ user: USER_DELIVERIES.find((item) => item === next) ?? user })}>
            <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.messaging.delivery.user')}>
              <SelectValue>{t(USER_DELIVERY_LABEL_KEYS[user])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {USER_DELIVERIES.map((item) => <SelectItem key={item} value={item}>{t(USER_DELIVERY_LABEL_KEYS[item])}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsFieldRow>
      </div>
    </SettingsSection>
  );
};

const SessionStartSection: React.FC<{ config: MessagingConfig; locked: boolean; onChange: (change: (config: MessagingConfig) => MessagingConfig) => void }> = ({ config, locked, onChange }) => {
  const { t } = useI18n();
  const enabled = config.session_start !== '';
  const setTemplate = (value: string | undefined) =>
    onChange((current) => {
      const next = { ...current };
      if (value === undefined) delete next.session_start;
      else next.session_start = value;
      return next;
    });

  return (
    <SettingsSection title={t('settings.messaging.section.sessionStart')} settingsItem="messaging.session-start">
      <div className="space-y-3">
        <SettingsCheckboxRow
          checked={enabled}
          disabled={locked}
          onChange={(checked) => setTemplate(checked ? undefined : '')}
          label={t('settings.messaging.sessionStart.enabled')}
        />
        {enabled ? (
          <SettingsStackedField label={t('settings.messaging.sessionStart.template')} info={t('settings.messaging.sessionStart.templateInfo')} controlClassName="max-w-[40rem]">
            <CommitInput
              value={config.session_start ?? ''}
              disabled={locked}
              placeholder={DEFAULT_SESSION_START}
              ariaLabel={t('settings.messaging.sessionStart.template')}
              className="font-mono text-xs"
              onCommit={(value) => setTemplate(value || undefined)}
            />
          </SettingsStackedField>
        ) : null}
      </div>
    </SettingsSection>
  );
};

/** One editable template row: the built-in value shows as the placeholder, and an override can be reset. */
const OverrideRow: React.FC<{ name: string; builtIn: string | undefined; override: string | undefined; current?: string; locked: boolean; onChange: (value: string | undefined) => void }> = ({ name, builtIn, override, current, locked, onChange }) => {
  const { t } = useI18n();
  return (
    <div className="space-y-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-28 flex-shrink-0 truncate font-mono typography-meta text-foreground" title={name}>{name}</span>
        <CommitInput
          value={override ?? ''}
          disabled={locked}
          placeholder={builtIn}
          ariaLabel={name}
          className="font-mono text-xs"
          onCommit={(value) => onChange(value || undefined)}
        />
        <button
          type="button"
          className={cn(SETTINGS_ICON_BUTTON_CLASS, override === undefined && 'invisible')}
          disabled={locked || override === undefined}
          aria-label={t('settings.messaging.presets.reset', { name })}
          title={t('settings.messaging.presets.reset', { name })}
          onClick={() => onChange(undefined)}
        >
          <Icon name="arrow-go-back" className="h-3.5 w-3.5" />
        </button>
      </div>
      {current ? <p className={cn(SETTINGS_HELPER_CLASS, 'ps-30 truncate')} title={current}>{t('settings.messaging.presets.value', { value: current })}</p> : null}
    </div>
  );
};

const AddPairRow: React.FC<{ addLabel: string; valuePlaceholder: string; disabled?: boolean; onAdd: (name: string, value: string) => void }> = ({ addLabel, valuePlaceholder, disabled = false, onAdd }) => {
  const { t } = useI18n();
  const [name, setName] = React.useState('');
  const [value, setValue] = React.useState('');
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name.trim()) && value.trim().length > 0;
  const add = () => {
    if (!valid) return;
    onAdd(name.trim(), value.trim());
    setName('');
    setValue('');
  };
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Input value={name} disabled={disabled} onChange={(event) => setName(event.target.value)} placeholder={t('settings.messaging.presets.namePlaceholder')} aria-label={t('settings.messaging.presets.namePlaceholder')} className="h-8 w-28 flex-shrink-0 rounded-md px-3 font-mono text-xs" />
      <Input value={value} disabled={disabled} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') add(); }} placeholder={valuePlaceholder} aria-label={valuePlaceholder} className="h-8 min-w-0 flex-1 rounded-md px-3 font-mono text-xs" />
      <Button type="button" variant="outline" size="sm" disabled={disabled || !valid} onClick={add}>{addLabel}</Button>
    </div>
  );
};

const TemplatesSection: React.FC<{ config: MessagingConfig; locked: boolean; onChange: (change: (config: MessagingConfig) => MessagingConfig) => void }> = ({ config, locked, onChange }) => {
  const { t } = useI18n();
  const sessionID = useSessionUIStore((state) => state.currentSessionId);
  const vars = useMessagingSettingsStore((state) => state.vars);
  const loadVars = useMessagingSettingsStore((state) => state.loadVars);
  const setGlobalVar = useMessagingSettingsStore((state) => state.setGlobalVar);
  const [showBuiltIn, setShowBuiltIn] = React.useState(false);

  React.useEffect(() => {
    void loadVars(sessionID);
  }, [loadVars, sessionID]);

  const setEntry = (key: 'presets' | 'vars', name: string, value: string | undefined) =>
    onChange((current) => {
      const entries = { ...(current[key] ?? {}) };
      if (value === undefined) delete entries[name];
      else entries[name] = value;
      const next: MessagingConfig = { ...current };
      if (Object.keys(entries).length === 0) delete next[key];
      else next[key] = entries;
      return next;
    });

  const presets = vars.data?.presets ?? [];
  const constants = (vars.data?.vars ?? []).filter((item) => item.kind === 'constant');
  const custom = (vars.data?.vars ?? []).filter((item) => item.kind === 'custom');
  const builtIn = (vars.data?.vars ?? []).filter((item) => item.kind === 'context' || item.kind === 'time');
  const configuredPresets = config.presets ?? {};
  const addedPresets = Object.keys(configuredPresets).filter((name) => !presets.some((preset) => preset.name === name));

  const builtInRow = (item: MessagingVar) => (
    <div key={item.name} className="flex min-w-0 items-center gap-2 typography-meta" title={item.description}>
      <span className="w-40 flex-shrink-0 truncate font-mono text-foreground">{item.name}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.value ?? item.description}</span>
    </div>
  );

  return (
    <>
      <SettingsSection title={t('settings.messaging.section.presets')} info={t('settings.messaging.section.presetsInfo')} settingsItem="messaging.presets">
        <div className="space-y-2">
          {vars.error ? <p className="typography-meta text-[var(--status-error)]">{t('settings.messaging.variables.loadFailed', { error: vars.error })}</p> : null}
          {presets.map((preset) => (
            <OverrideRow
              key={preset.name}
              name={preset.name}
              builtIn={preset.template}
              override={configuredPresets[preset.name]}
              current={preset.value}
              locked={locked}
              onChange={(value) => setEntry('presets', preset.name, value)}
            />
          ))}
          {addedPresets.map((name) => (
            <OverrideRow key={name} name={name} builtIn={undefined} override={configuredPresets[name]} locked={locked} onChange={(value) => setEntry('presets', name, value)} />
          ))}
          <AddPairRow
            addLabel={t('settings.messaging.presets.add')}
            valuePlaceholder={t('settings.messaging.presets.templatePlaceholder')}
            disabled={locked}
            onAdd={(name, value) => setEntry('presets', name, value)}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.messaging.section.constants')} info={t('settings.messaging.section.constantsInfo')} settingsItem="messaging.constants">
        <div className="space-y-2">
          {constants.map((item) => (
            <OverrideRow
              key={item.name}
              name={item.name}
              builtIn={item.template ?? item.value}
              override={config.vars?.[item.name]}
              locked={locked}
              onChange={(value) => setEntry('vars', item.name, value)}
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.messaging.section.variables')} info={t('settings.messaging.section.variablesInfo')} settingsItem="messaging.variables">
        <div className="space-y-2">
          {custom.map((item) => (
            <div key={`${item.scope ?? ''}:${item.name}`} className="flex min-w-0 items-center gap-2 typography-meta">
              <span className="w-28 flex-shrink-0 truncate font-mono text-foreground" title={item.name}>{item.name}</span>
              <span className="min-w-0 flex-1 truncate text-foreground" title={item.value}>{item.value}</span>
              <span className="flex-shrink-0 truncate text-muted-foreground">{item.scope === 'global' ? t('settings.messaging.variables.scopeGlobal') : item.scope}</span>
              {item.scope === 'global' ? (
                <button
                  type="button"
                  className={SETTINGS_ICON_BUTTON_CLASS}
                  aria-label={t('settings.messaging.variables.remove', { name: item.name })}
                  title={t('settings.messaging.variables.remove', { name: item.name })}
                  onClick={() => void setGlobalVar(item.name, undefined, sessionID)}
                >
                  <Icon name="close" className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ))}
          <AddPairRow
            addLabel={t('settings.messaging.variables.add')}
            valuePlaceholder={t('settings.messaging.variables.valuePlaceholder')}
            onAdd={(name, value) => void setGlobalVar(name, value, sessionID)}
          />
          <Button type="button" variant="chip" size="xs" aria-pressed={showBuiltIn} onClick={() => setShowBuiltIn((value) => !value)}>
            {t('settings.messaging.variables.showBuiltIn')}
          </Button>
          {showBuiltIn ? <div className="space-y-0.5">{builtIn.map(builtInRow)}</div> : null}
        </div>
      </SettingsSection>
    </>
  );
};

export const MessagingPage: React.FC = () => {
  const { t } = useI18n();
  const directory = useSettingsDirectory();
  const config = useMessagingSettingsStore((state) => state.config);
  const load = useMessagingSettingsStore((state) => state.load);
  const update = useMessagingSettingsStore((state) => state.update);
  const support = useMessagingStore((state) => state.support);
  const checkSupport = useMessagingStore((state) => state.checkSupport);
  const scope = getMessagingSettingsScope(directory);

  React.useEffect(() => {
    void load(directory);
  }, [directory, load, scope]);
  React.useEffect(() => {
    void checkSupport();
  }, [checkSupport]);

  const snapshot = config.kind === 'ready' && config.scope === scope ? config.snapshot : null;
  // A project config that sets `messaging` wins over the file Settings writes, so a change here would not apply there.
  const locked = snapshot !== null && snapshot.projectPath !== null;
  const onChange = React.useCallback((change: (config: MessagingConfig) => MessagingConfig) => {
    void update(change).then((ok) => {
      if (!ok) toast.error(t('settings.messaging.toast.saveFailed'));
    });
  }, [t, update]);

  return (
    <SettingsPageLayout title={t('settings.page.messaging.title')} description={t('settings.page.messaging.description')} showSaveStatus>
      {support.kind === 'unsupported' ? (
        <SettingsSection divider={false}>
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.messaging.state.unsupported')}</p>
          <Button type="button" variant="outline" size="xs" onClick={() => void checkSupport({ force: true })}>
            {t('settings.messaging.actions.retry')}
          </Button>
        </SettingsSection>
      ) : null}
      {snapshot ? (
        <>
          {snapshot.projectPath ? (
            <SettingsSection divider={false}>
              <p className={cn(SETTINGS_HELPER_CLASS, 'break-all')}>{t('settings.messaging.state.projectOverride', { path: snapshot.projectPath })}</p>
            </SettingsSection>
          ) : null}
          {support.kind === 'supported' ? (
            <ModelSection config={snapshot.config} locked={locked} onChange={onChange} />
          ) : null}
          <RemoteSection config={snapshot.config} locked={locked} onChange={onChange} />
          <SearchSection config={snapshot.config} locked={locked} onChange={onChange} />
          <DeliverySection config={snapshot.config} locked={locked} onChange={onChange} />
          <SessionStartSection config={snapshot.config} locked={locked} onChange={onChange} />
          {support.kind === 'supported' ? <TemplatesSection config={snapshot.config} locked={locked} onChange={onChange} /> : null}
        </>
      ) : config.kind === 'failed' && config.scope === scope ? (
        <SettingsSection divider={false}>
          <div className="flex flex-wrap items-center gap-3">
            <p className="typography-meta text-[var(--status-error)]">{t('settings.messaging.state.loadFailed', { error: config.error })}</p>
            <Button variant="outline" size="xs" onClick={() => void load(directory)}>{t('settings.messaging.actions.retry')}</Button>
          </div>
        </SettingsSection>
      ) : (
        <SettingsSection divider={false}>
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.messaging.state.loading')}</p>
        </SettingsSection>
      )}
    </SettingsPageLayout>
  );
};
