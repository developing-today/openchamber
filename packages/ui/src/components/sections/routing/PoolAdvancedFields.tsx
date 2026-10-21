import React from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  SETTINGS_HELPER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { ModelRoute } from '@/lib/routing/modelRoutesApi';
import {
  isConcreteTarget,
  parseFormNumber,
  pickedValue,
  pruneEmpty,
  routeReferenceID,
  setRouteField,
  setTargetEntry,
  targetReference,
  withOptional,
} from '@/lib/routing/poolAdvanced';
import { cn } from '@/lib/utils';

type Health = NonNullable<ModelRoute['health']>;
type Budget = NonNullable<NonNullable<ModelRoute['budgets']>[string]>;

const SELECTION_LABEL_KEYS = {
  ordered: 'settings.pools.advanced.selection.ordered',
  'round-robin': 'settings.pools.advanced.selection.roundRobin',
  weighted: 'settings.pools.advanced.selection.weighted',
} as const satisfies Record<NonNullable<ModelRoute['selection']>, I18nKey>;

const SECONDS = 1000;

const isValidFormNumber = (value: number | undefined, min: number, max: number, step: number | 'any') =>
  value === undefined || (value >= min && value <= max && (step !== 1 || Number.isInteger(value)));

/** A form number that commits on blur or Enter and refuses values outside its range. */
export const RangedNumberField: React.FC<{
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  step?: number | 'any';
  placeholder?: string;
  disabled?: boolean;
  onCommit: (value: number | undefined) => void;
}> = ({ label, value, min, max, step = 1, placeholder, disabled = false, onCommit }) => {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(value === undefined ? '' : String(value));
  const valid = isValidFormNumber(parseFormNumber(draft), min, max, step);

  React.useEffect(() => {
    setDraft(value === undefined ? '' : String(value));
  }, [value]);

  const commit = (text: string) => {
    setDraft(text);
    const next = parseFormNumber(text);
    if (!isValidFormNumber(next, min, max, step) || next === value) return;
    onCommit(next);
  };

  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="typography-meta text-muted-foreground">{label}</span>
      <Input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        aria-invalid={!valid}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(event.currentTarget.value);
        }}
        className={cn('h-8 w-full min-w-0 rounded-md px-2', !valid && 'border-destructive')}
      />
      {valid ? null : (
        <span className="typography-meta text-destructive">{t('settings.pools.advanced.range', { min, max })}</span>
      )}
    </label>
  );
};

const seconds = (ms: number | undefined) => (ms === undefined ? undefined : ms / SECONDS);
const toMs = (value: number | undefined) => (value === undefined ? undefined : Math.round(value * SECONDS));
const percent = (fraction: number | undefined) => (fraction === undefined ? undefined : Math.round(fraction * 1000) / 10);
const fromPercent = (value: number | undefined) => (value === undefined ? undefined : Math.round(value * 10) / 1000);

/** Expert-level pool settings, grouped by what they change: selection, failover, health and budgets. */
export const PoolAdvancedFields: React.FC<{ route: ModelRoute; onChange: (route: ModelRoute) => void }> = ({ route, onChange }) => {
  const { t } = useI18n();
  const health: Health = route.health ?? {};
  const budgets = route.budgets ?? {};
  const concrete = (route.targets ?? []).filter(isConcreteTarget);
  const references = [...new Set(concrete.map(targetReference))];
  const modelReferences = [...new Set(concrete.filter((target) => routeReferenceID(target) === null).map(targetReference))];

  const setHealth = (key: keyof Health, value: unknown) =>
    onChange(setRouteField(route, 'health', pruneEmpty(withOptional(route.health, key, value))));

  const setBudget = (reference: string, key: keyof Budget, value: number | undefined) => {
    const entry = withOptional(budgets[reference], key, value) as Budget;
    onChange(setRouteField(route, 'budgets', setTargetEntry(route.budgets, reference, entry)));
  };

  const setWeight = (reference: string, value: number | undefined) => {
    const weights: Record<string, number> = { ...(route.weights ?? {}) };
    if (value === undefined) delete weights[reference];
    else weights[reference] = value;
    onChange(setRouteField(route, 'weights', pruneEmpty(weights)));
  };

  const heading = 'typography-ui-label font-medium text-foreground';

  return (
    <div className="space-y-4">
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.advanced.help')}</p>

      <SettingsFieldRow label={t('settings.pools.advanced.selection')} description={t('settings.pools.advanced.selectionInfo')} settingsItem="pools.selection">
        <Select
          value={route.selection ?? '__unset__'}
          onValueChange={(next) => onChange(setRouteField(route, 'selection', pickedValue(next)))}
        >
          <SelectTrigger className={cn(SETTINGS_SELECT_ROW_TRIGGER_CLASS, 'w-56')} aria-label={t('settings.pools.advanced.selection')}>
            <SelectValue>{route.selection ? t(SELECTION_LABEL_KEYS[route.selection]) : t('settings.pools.advanced.selectionDefault')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__unset__">{t('settings.pools.advanced.selectionDefault')}</SelectItem>
            <SelectItem value="ordered">{t(SELECTION_LABEL_KEYS.ordered)}</SelectItem>
            <SelectItem value="round-robin">{t(SELECTION_LABEL_KEYS['round-robin'])}</SelectItem>
            <SelectItem value="weighted">{t(SELECTION_LABEL_KEYS.weighted)}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>

      {route.selection === 'weighted' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {references.map((reference) => (
            <RangedNumberField
              key={reference}
              label={`${t('settings.pools.advanced.weight')}: ${reference}`}
              value={route.weights?.[reference]}
              min={0.01}
              max={1000}
              step="any"
              placeholder="1"
              onCommit={(value) => setWeight(reference, value)}
            />
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <RangedNumberField
          label={t('settings.pools.advanced.attempts')}
          value={route.attempts}
          min={1}
          max={50}
          placeholder="2"
          onCommit={(value) => onChange(setRouteField(route, 'attempts', value))}
        />
        <RangedNumberField
          label={t('settings.pools.advanced.hedge')}
          value={seconds(route.hedgeAfterMs)}
          min={1}
          max={3600}
          placeholder={t('settings.pools.advanced.off')}
          onCommit={(value) => onChange(setRouteField(route, 'hedgeAfterMs', toMs(value)))}
        />
      </div>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.advanced.hedgeInfo')}</p>

      <div className="space-y-2">
        <p className={heading}>{t('settings.pools.advanced.health')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="typography-meta text-muted-foreground">{t('settings.pools.advanced.firstToken')}</span>
            <div className="flex h-8 items-center gap-3">
              <Switch
                checked={health.firstTokenTimeoutMs === false}
                onCheckedChange={(checked) => setHealth('firstTokenTimeoutMs', checked ? false : undefined)}
                aria-label={t('settings.pools.advanced.firstTokenOff')}
              />
              <span className="typography-meta text-muted-foreground">{t('settings.pools.advanced.firstTokenOff')}</span>
            </div>
          </div>
          <RangedNumberField
            label={t('settings.pools.advanced.firstToken')}
            value={typeof health.firstTokenTimeoutMs === 'number' ? seconds(health.firstTokenTimeoutMs) : undefined}
            min={1}
            max={3600}
            placeholder="10"
            disabled={health.firstTokenTimeoutMs === false}
            onCommit={(value) => setHealth('firstTokenTimeoutMs', toMs(value))}
          />
          <RangedNumberField
            label={t('settings.pools.advanced.maxResponse')}
            value={seconds(health.maxResponseTimeMs)}
            min={1}
            max={3600}
            placeholder={t('settings.pools.advanced.off')}
            onCommit={(value) => setHealth('maxResponseTimeMs', toMs(value))}
          />
          <RangedNumberField
            label={t('settings.pools.advanced.minRate')}
            value={health.minOutputTokensPerSecond}
            min={0.1}
            max={100000}
            step="any"
            placeholder={t('settings.pools.advanced.off')}
            onCommit={(value) => setHealth('minOutputTokensPerSecond', value)}
          />
          <RangedNumberField
            label={t('settings.pools.advanced.cooldown')}
            value={seconds(health.cooldownMs)}
            min={1}
            max={3600}
            placeholder="60"
            onCommit={(value) => setHealth('cooldownMs', toMs(value))}
          />
          <RangedNumberField
            label={t('settings.pools.advanced.quotaCooldown')}
            value={seconds(health.quotaCooldownMs)}
            min={1}
            max={3600}
            placeholder="900"
            onCommit={(value) => setHealth('quotaCooldownMs', toMs(value))}
          />
          <RangedNumberField
            label={t('settings.pools.advanced.sampleWindow')}
            value={health.sampleWindow}
            min={1}
            max={50}
            placeholder="5"
            onCommit={(value) => setHealth('sampleWindow', value)}
          />
          <RangedNumberField
            label={t('settings.pools.advanced.slowThreshold')}
            value={health.slowThreshold}
            min={1}
            max={50}
            placeholder="3"
            onCommit={(value) => setHealth('slowThreshold', value)}
          />
        </div>
      </div>

      {modelReferences.length > 0 ? (
        <div className="space-y-2">
          <p className={heading}>{t('settings.pools.advanced.budgets')}</p>
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.advanced.budgetsInfo')}</p>
          {modelReferences.map((reference) => {
            const budget: Budget = budgets[reference] ?? {};
            return (
              <div key={reference} className="space-y-2 rounded-md border border-border/40 p-3">
                <p className="typography-meta truncate text-foreground">{reference}</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <RangedNumberField label={t('settings.pools.advanced.requestsPerMinute')} value={budget.requestsPerMinute} min={1} max={1e9} onCommit={(value) => setBudget(reference, 'requestsPerMinute', value)} />
                  <RangedNumberField label={t('settings.pools.advanced.requestsPerDay')} value={budget.requestsPerDay} min={1} max={1e9} onCommit={(value) => setBudget(reference, 'requestsPerDay', value)} />
                  <RangedNumberField label={t('settings.pools.advanced.tokensPerMinute')} value={budget.tokensPerMinute} min={1} max={1e12} onCommit={(value) => setBudget(reference, 'tokensPerMinute', value)} />
                  <RangedNumberField label={t('settings.pools.advanced.tokensPerDay')} value={budget.tokensPerDay} min={1} max={1e12} onCommit={(value) => setBudget(reference, 'tokensPerDay', value)} />
                  <RangedNumberField
                    label={t('settings.pools.advanced.softLimit')}
                    value={percent(budget.softLimit)}
                    min={12.5}
                    max={100}
                    step="any"
                    placeholder="90"
                    onCommit={(value) => setBudget(reference, 'softLimit', fromPercent(value))}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
