import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import {
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsFieldRow,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  AUTONOMY_LEVELS,
  UNREADABLE_TUNING,
  fetchModelRoutes,
  fetchRouteStats,
  modelRouteEntryJson,
  readModelRouteJsonText,
  saveModelRouteTuning,
  saveModelRoutes,
  type HedgeAccuracy,
  type ModelRoute,
  type ModelRouteEntry,
  type ModelRouteTuning,
  type PoolProblem,
  type PoolProblems,
  type RouteErrorGroup,
  type RouteTargetStats,
} from '@/lib/routing/modelRoutesApi';
import { PoolAdvancedFields } from '@/components/sections/routing/PoolAdvancedFields';
import { CommitInput, PoolTargetOptions } from '@/components/sections/routing/PoolTargetOptions';
import { RouteTuningFields } from '@/components/sections/routing/RouteTuningFields';
import { fetchWaitEstimate, type WaitEstimate } from '@/lib/routing/routeRulesApi';
import { PRESET_ROUTE_IDS, presetTargets, type PresetId } from '@/lib/routing/routePresets';
import { hasModelSource, pickedAutonomy, routeReference, routeReferenceID, targetLabel, targetUntil, withoutAbsentWeights } from '@/lib/routing/poolAdvanced';
import { useConfigStore } from '@/stores/useConfigStore';
import { useRoutingStore } from '@/stores/useRoutingStore';

const PRESETS = [
  { id: 'cheap', titleKey: 'settings.pools.preset.cheap', infoKey: 'settings.pools.preset.cheapInfo' },
  { id: 'fast', titleKey: 'settings.pools.preset.fast', infoKey: 'settings.pools.preset.fastInfo' },
  { id: 'sturdy', titleKey: 'settings.pools.preset.sturdy', infoKey: 'settings.pools.preset.sturdyInfo' },
] as const;

type RouteTarget = NonNullable<ModelRoute['targets']>[number];

/** The concrete provider and model of a target, or null for a pattern or another pool. */
const concreteTarget = (target: RouteTarget): { providerID: string; modelID: string } | null => {
  if (routeReferenceID(target) !== null) return null;
  const [ref] = targetLabel(target).split('#');
  const slash = ref.indexOf('/');
  if (slash <= 0) return null;
  const modelID = ref.slice(slash + 1);
  if (modelID.includes('*')) return null;
  return { providerID: ref.slice(0, slash), modelID };
};

const TargetWait: React.FC<{ providerID: string; modelID: string }> = ({ providerID, modelID }) => {
  const { t } = useI18n();
  const [estimate, setEstimate] = React.useState<WaitEstimate | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchWaitEstimate(providerID, modelID)
      .then((next) => {
        if (!cancelled) setEstimate(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [providerID, modelID]);

  if (!estimate) return null;
  if (estimate.active) {
    return (
      <span className="typography-meta text-muted-foreground">
        {t('settings.pools.wait.cooling', { minutes: Math.ceil(estimate.active.remainingMs / 60_000) })}
      </span>
    );
  }
  if (estimate.expectedMs === null) {
    return <span className="typography-meta text-muted-foreground">{t('settings.pools.wait.none')}</span>;
  }
  return (
    <span className="typography-meta text-muted-foreground">
      {t('settings.pools.wait.expected', { minutes: Math.ceil(estimate.expectedMs / 60_000) })}
    </span>
  );
};

/** A pool's structured editor: display name, autonomy, targets and the advanced options. */
const PoolFields: React.FC<{
  id: string;
  route: ModelRoute;
  otherPoolIDs: string[];
  onChange: (route: ModelRoute) => void;
}> = ({ id, route, otherPoolIDs, onChange }) => {
  const { t } = useI18n();
  const [providerId, setProviderId] = React.useState('');
  const [modelId, setModelId] = React.useState('');
  const [pattern, setPattern] = React.useState('');
  const [patternUntil, setPatternUntil] = React.useState('');
  const [advancedOpen, setAdvancedOpen] = React.useState(false);

  const targets = route.targets ?? [];
  const addTarget = () => {
    if (!providerId || !modelId) return;
    const ref = `${providerId}/${modelId}`;
    if (targets.some((entry) => targetLabel(entry) === ref)) return;
    onChange({ ...route, targets: [...targets, ref] });
    setProviderId('');
    setModelId('');
  };

  const addPattern = () => {
    const model = pattern.trim();
    if (!model || targets.some((entry) => targetLabel(entry) === model)) return;
    const until = patternUntil ? new Date(patternUntil).getTime() : Number.NaN;
    const entry: RouteTarget = Number.isFinite(until) ? { model, until } : model;
    onChange({ ...route, targets: [...targets, entry] });
    setPattern('');
    setPatternUntil('');
  };

  return (
    <>
      <SettingsStackedField label={t('settings.pools.name')} info={t('settings.pools.nameInfo')} controlClassName="max-w-none">
        <CommitInput
          label={t('settings.pools.name')}
          value={route.name ?? ''}
          placeholder={id}
          onCommit={(next) => onChange({ ...route, name: next || undefined })}
        />
      </SettingsStackedField>
      <SettingsStackedField label={t('settings.pools.autonomy')} info={t('settings.pools.autonomyInfo')} controlClassName="max-w-none">
        <Select
          value={route.autonomy ?? '__unset__'}
          onValueChange={(next) => onChange({ ...route, autonomy: pickedAutonomy(next) })}
        >
          <SelectTrigger className={cn(SETTINGS_SELECT_ROW_TRIGGER_CLASS, 'w-full')} aria-label={t('settings.pools.autonomy')}>
            <SelectValue>{route.autonomy ? t(`settings.pools.autonomy.${route.autonomy}`) : t('settings.pools.autonomyDefault')}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__unset__">{t('settings.pools.autonomyDefault')}</SelectItem>
            {AUTONOMY_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {t(`settings.pools.autonomy.${level}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsStackedField>
      <p className={SETTINGS_HELPER_CLASS}>{t(`settings.pools.autonomyHelp.${route.autonomy ?? 'unset'}`)}</p>
      <div className="space-y-1">
        {targets.map((target, index) => {
          const until = targetUntil(target);
          const concrete = concreteTarget(target);
          const pool = routeReferenceID(target);
          return (
          <div key={`${targetLabel(target)}-${index}`} className="space-y-1">
            {/* Below the @xl width the name takes a line of its own and wraps, so the model part always shows. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="typography-ui-label min-w-0 grow basis-full break-words @xl:basis-0">
                {pool !== null ? `${t('settings.pools.targetPool')}: ${pool}` : targetLabel(target)}
                {until !== undefined ? (
                  <span className="typography-meta text-muted-foreground">
                    {` · ${t('settings.pools.pattern.untilLabel', { time: new Date(until).toLocaleString() })}`}
                  </span>
                ) : null}
              </span>
              {concrete ? <TargetWait providerID={concrete.providerID} modelID={concrete.modelID} /> : null}
              <Button
                size="sm"
                variant="ghost"
                className="ms-auto"
                onClick={() => onChange({ ...route, targets: targets.filter((_, i) => i !== index) })}
              >
                {t('settings.pools.removeTarget')}
              </Button>
            </div>
            <PoolTargetOptions
              target={target}
              onChange={(next) => onChange({ ...route, targets: targets.map((entry, i) => (i === index ? next : entry)) })}
            />
          </div>
          );
        })}
      </div>
      {otherPoolIDs.length > 0 ? (
        <SettingsStackedField label={t('settings.pools.addPoolTarget')} info={t('settings.pools.addPoolTargetInfo')} controlClassName="max-w-none">
          <Select
            value=""
            onValueChange={(next) => onChange({ ...route, targets: [...targets, routeReference(next)] })}
          >
            <SelectTrigger className={cn(SETTINGS_SELECT_ROW_TRIGGER_CLASS, 'w-full')} aria-label={t('settings.pools.addPoolTarget')}>
              <SelectValue placeholder={t('settings.pools.addPoolTargetPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {otherPoolIDs.map((poolID) => (
                <SelectItem key={poolID} value={poolID}>
                  {poolID}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsStackedField>
      ) : null}
      <SettingsStackedField label={t('settings.pools.pattern.label')} info={t('settings.pools.pattern.info')} controlClassName="max-w-none">
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
          {/* Below the @xl width the pattern takes a line of its own, so the date field cannot squeeze it to a few characters. */}
          <Input
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            placeholder={t('settings.pools.pattern.placeholder')}
            aria-label={t('settings.pools.pattern.label')}
            className="h-8 min-w-0 grow basis-full rounded-md px-3 @xl:basis-0"
            maxLength={200}
          />
          <Input
            type="datetime-local"
            value={patternUntil}
            onChange={(event) => setPatternUntil(event.target.value)}
            aria-label={t('settings.pools.pattern.until')}
            title={t('settings.pools.pattern.untilInfo')}
            className="h-8 w-auto min-w-0 rounded-md px-2"
          />
          <Button size="sm" variant="outline" onClick={addPattern} disabled={!pattern.trim()}>
            {t('settings.pools.pattern.add')}
          </Button>
        </div>
      </SettingsStackedField>
      <div className="flex w-full min-w-0 items-center gap-2">
        <ModelSelector
          providerId={providerId}
          modelId={modelId}
          onChange={(nextProvider, nextModel) => {
            setProviderId(nextProvider);
            setModelId(nextModel);
          }}
          className={cn(SETTINGS_CUSTOM_TRIGGER_CLASS, 'w-full')}
          placeholder={t('settings.pools.addTargetPlaceholder')}
        />
        <Button size="sm" variant="outline" onClick={addTarget} disabled={!providerId || !modelId}>
          {t('settings.pools.addTarget')}
        </Button>
      </div>
      <div className="space-y-2">
        <Button size="sm" variant="ghost" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}>
          {advancedOpen ? t('settings.pools.advanced.hide') : t('settings.pools.advanced.show')}
        </Button>
        {advancedOpen ? <PoolAdvancedFields route={route} onChange={onChange} /> : null}
      </div>
    </>
  );
};

/** The pool as stored in opencode.json, as text. An edit applies when it parses as JSON; the server checks it on save. */
const PoolJsonField: React.FC<{ entry: ModelRouteEntry; onApply: (entry: ModelRouteEntry) => void }> = ({ entry, onApply }) => {
  const { t } = useI18n();
  const [jsonText, setJsonText] = React.useState<string | null>(null);
  const [jsonError, setJsonError] = React.useState<string | null>(null);

  const applyJson = () => {
    if (jsonText === null) return;
    try {
      const next = readModelRouteJsonText(jsonText);
      setJsonError(null);
      setJsonText(null);
      onApply(next);
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <SettingsStackedField label={t('settings.pools.expertJson')} info={t('settings.pools.expertJsonInfo')} controlClassName="max-w-none">
        <Textarea
          value={jsonText ?? JSON.stringify(modelRouteEntryJson(entry), null, 2)}
          onChange={(event) => setJsonText(event.target.value)}
          aria-label={t('settings.pools.expertJson')}
          rows={8}
          className="w-full font-mono text-xs"
          spellCheck={false}
        />
      </SettingsStackedField>
      {jsonError ? <p className={SETTINGS_HELPER_CLASS}>{jsonError}</p> : null}
      {jsonText !== null ? (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={applyJson}>
            {t('settings.pools.applyJson')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setJsonText(null); setJsonError(null); }}>
            {t('settings.pools.discardJson')}
          </Button>
        </div>
      ) : null}
    </>
  );
};

/** OpenChamber's warnings for a pool, each saying whether OpenCode leaves the pool out. */
const PoolProblemLines: React.FC<{ problems: readonly PoolProblem[]; className: string }> = ({ problems, className }) => {
  const { t } = useI18n();
  return (
    <>
      {problems.map((problem, index) => (
        <p key={index} className={cn('typography-meta', className)}>
          {problem.skipsPool
            ? t('settings.pools.problem.skipped', { problem: problem.message })
            : t('settings.pools.problem.unchecked', { problem: problem.message })}
        </p>
      ))}
    </>
  );
};

type Translate = ReturnType<typeof useI18n>['t'];

/** A list of patterns, texts or levels as one value, or null when the list is unset or empty. */
const listed = (values: readonly string[] | undefined): string | null => (values && values.length > 0 ? values.join(', ') : null);

/** The pool's matching keys and declared levels in words, each kind labeled, one entry per key that says something. */
const poolRuleTexts = (route: ModelRoute, t: Translate): string[] => {
  const texts: string[] = [];
  const include = listed(route.include);
  if (include) texts.push(t('settings.pools.rules.include', { patterns: include }));
  const exclude = listed(route.exclude);
  if (exclude) texts.push(t('settings.pools.rules.exclude', { patterns: exclude }));
  const contains = listed(route.contains);
  if (contains) texts.push(t('settings.pools.rules.contains', { texts: contains }));
  const notContains = listed(route.notContains);
  if (notContains) texts.push(t('settings.pools.rules.notContains', { texts: notContains }));
  if (route.match !== undefined) texts.push(t('settings.pools.rules.match', { expression: route.match }));
  // An empty list is a choice too: the pool then offers no levels.
  const levels = listed(route.levels);
  if (levels) texts.push(t('settings.pools.rules.levels', { levels }));
  else if (route.levels !== undefined) texts.push(t('settings.pools.rules.noLevels'));
  return texts;
};

/** The pool's variant rules in words: for the models a rule matches, what each level runs at. */
const variantRuleTexts = (route: ModelRoute, t: Translate): string[] =>
  (route.variantRules ?? []).map((rule) =>
    t('settings.pools.rules.variantRule', {
      match: rule.match,
      remaps: Object.entries(rule.map)
        .map(([level, variant]) => (variant === false ? t('settings.pools.rules.sitsOut', { level }) : `${level} → ${variant}`))
        .join(', '),
    }),
  );

/** The pool's one-line summary: its target count, its rules and its autonomy. */
const poolSummary = (route: ModelRoute, t: Translate): string => {
  const rules = poolRuleTexts(route, t);
  // A pool that only takes models by pattern has no target list to count.
  const count = route.targets !== undefined || rules.length === 0 ? [t('settings.pools.targetCount', { count: route.targets?.length ?? 0 })] : [];
  return [...count, ...rules, ...(route.autonomy ? [t(`settings.pools.autonomy.${route.autonomy}`)] : [])].join(' · ');
};

/** The matching keys, declared levels and variant rules, read only: the structured editor keeps them as read and they change in the pool's JSON. */
const PoolRules: React.FC<{ route: ModelRoute }> = ({ route }) => {
  const { t } = useI18n();
  const lines = [...poolRuleTexts(route, t), ...variantRuleTexts(route, t)];
  if (lines.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="typography-ui-label font-medium text-foreground">{t('settings.pools.rules.title')}</p>
      {lines.map((line, index) => (
        <p key={index} className="typography-meta break-words text-muted-foreground">
          {line}
        </p>
      ))}
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.rules.editAsJson')}</p>
    </div>
  );
};

/** One pool: its summary row, its warnings, and its editor when expanded. A pool the editor cannot show is edited as JSON only. */
const PoolRow: React.FC<{
  id: string;
  entry: ModelRouteEntry;
  problems: readonly PoolProblem[];
  otherPoolIDs: string[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (entry: ModelRouteEntry) => void;
  onRemove: () => void;
}> = ({ id, entry, problems, otherPoolIDs, expanded, onToggle, onChange, onRemove }) => {
  const { t } = useI18n();
  const route = entry.kind === 'editable' ? entry.route : null;
  const summary = route ? poolSummary(route, t) : t('settings.pools.json.label');

  return (
    <div className="py-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-start hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* The name keeps its width and the summary truncates first; the name truncates only when it alone fills the row. */}
          <span className="typography-ui-label font-medium text-foreground max-w-full shrink-0 truncate">
            {route?.name || id}
          </span>
          <span className="typography-meta text-muted-foreground truncate" title={summary}>
            {summary}
          </span>
        </button>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {t('settings.pools.remove')}
        </Button>
      </div>
      {problems.length > 0 ? (
        <div className="space-y-1 px-1">
          <PoolProblemLines problems={problems} className="text-[var(--status-warning)]" />
        </div>
      ) : null}
      {expanded ? (
        <div className="space-y-4 px-1 pb-4 pt-2">
          {entry.kind === 'editable' ? (
            <>
              <PoolFields
                id={id}
                route={entry.route}
                otherPoolIDs={otherPoolIDs}
                // A removed target takes its weight with it, so the edit is not refused for a weight without a target.
                onChange={(next) => onChange({ kind: 'editable', route: withoutAbsentWeights(next) })}
              />
              <PoolRules route={entry.route} />
            </>
          ) : (
            <p className={SETTINGS_HELPER_CLASS}>
              {entry.unreadablePath
                ? t('settings.pools.json.reason', { path: entry.unreadablePath })
                : t('settings.pools.json.reasonWhole')}
            </p>
          )}
          <PoolJsonField entry={entry} onApply={onChange} />
        </div>
      ) : null}
    </div>
  );
};

/** Live telemetry from OpenCode's routing history: per-target performance, exact errors and hedge wins. */
const PoolTelemetry: React.FC = () => {
  const { t } = useI18n();
  const [stats, setStats] = React.useState<{
    targets: RouteTargetStats[];
    errors: RouteErrorGroup[];
    hedges: HedgeAccuracy[];
    windowHours?: number;
  } | null>(null);
  const [unavailable, setUnavailable] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchRouteStats()
      .then((state) => {
        if (cancelled) return;
        if (!state.available || !state.targets) {
          setUnavailable(state.reason ?? 'unknown');
          return;
        }
        setStats({ targets: state.targets, errors: state.errors ?? [], hedges: state.hedges ?? [], windowHours: state.windowHours });
      })
      .catch(() => {
        if (!cancelled) setUnavailable('unreachable');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (unavailable) return null;
  if (!stats) return <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.telemetry.loading')}</p>;
  if (stats.targets.length === 0) return <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.telemetry.empty')}</p>;
  const hedgeRate = (row: HedgeAccuracy) =>
    row.hedges === 0 ? '—' : `${Math.round((row.wins / row.hedges) * 100)}% (${row.wins}/${row.hedges})`;
  const hedgeFor = (providerID: string, modelID: string) =>
    stats.hedges.find((row) => row.providerID === providerID && row.modelID === modelID);
  return (
    <div className="space-y-2">
      <p className={SETTINGS_HELPER_CLASS}>
        {t('settings.pools.telemetry.description', { hours: stats.windowHours ?? 24 })}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-start typography-meta">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 pe-3 font-medium">{t('settings.pools.telemetry.target')}</th>
              <th className="py-1 pe-3 font-medium">{t('settings.pools.telemetry.attempts')}</th>
              <th className="py-1 pe-3 font-medium">{t('settings.pools.telemetry.failed')}</th>
              <th className="py-1 pe-3 font-medium">{t('settings.pools.telemetry.firstToken')}</th>
              <th className="py-1 pe-3 font-medium">{t('settings.pools.telemetry.hedgeWins')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {stats.targets.map((row) => {
              const hedge = hedgeFor(row.providerID, row.modelID);
              return (
                <tr key={`${row.providerID}/${row.modelID}`}>
                  <td className="py-1 pe-3 text-foreground truncate">{`${row.providerID}/${row.modelID}`}</td>
                  <td className="py-1 pe-3">{row.attempts}</td>
                  <td className="py-1 pe-3">{`${row.failures}${row.timeouts > 0 ? ` (${row.timeouts} timeouts)` : ''}`}</td>
                  <td className="py-1 pe-3">{row.avgFirstTokenMs === null ? '—' : `${row.avgFirstTokenMs}ms`}</td>
                  <td className="py-1 pe-3">{hedge ? hedgeRate(hedge) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {stats.errors.length > 0 ? (
        <div className="space-y-1">
          {stats.errors.slice(0, 8).map((error, index) => (
            <p key={index} className="typography-meta text-muted-foreground truncate">
              {`${error.providerID}/${error.modelID} ×${error.count}: ${error.tag ?? 'unknown'}${error.status ? ` ${error.status}` : ''}${error.lastMessage ? ` — ${error.lastMessage}` : ''}`}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
};

/** Model pools: beginner presets, per-pool autonomy, and an expert raw view. */
export const ModelPoolsSection: React.FC = () => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const decisions = useRoutingStore((state) => state.decisions);
  const [routes, setRoutes] = React.useState<Record<string, ModelRouteEntry> | null>(null);
  const [problems, setProblems] = React.useState<PoolProblems>({});
  const [drafts, setDrafts] = React.useState<Record<string, ModelRoute>>({});
  const [tuning, setTuning] = React.useState<ModelRouteTuning | null | typeof UNREADABLE_TUNING>(null);
  // A save the server refused: what was sent, so Save anyway can send it again, and the problems it named.
  const [refusal, setRefusal] = React.useState<{ routes: Record<string, ModelRouteEntry>; problems: PoolProblems } | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [newId, setNewId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const lastSavedRef = React.useRef<Record<string, ModelRouteEntry> | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchModelRoutes()
      .then((state) => {
        if (!cancelled && state.available) {
          lastSavedRef.current = state.routes;
          setRoutes(state.routes);
          setProblems(state.problems);
          setTuning(state.tuning);
        }
      })
      .catch((failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = React.useCallback(async (next: Record<string, ModelRouteEntry>, force = false) => {
    setRoutes(next);
    setRefusal(null);
    setSaving(true);
    // A failed or refused save rolls back to the last server-confirmed state,
    // so the list never shows pools that were not written.
    try {
      const result = await saveModelRoutes(next, { force });
      if (result.kind === 'refused') {
        if (lastSavedRef.current) setRoutes(lastSavedRef.current);
        setRefusal({ routes: next, problems: result.problems });
        setError(null);
        return;
      }
      lastSavedRef.current = result.state.routes;
      setRoutes(result.state.routes);
      setProblems(result.state.problems);
      setError(null);
    } catch (failure) {
      if (lastSavedRef.current) setRoutes(lastSavedRef.current);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }, []);

  const saveTuning = React.useCallback(async (next: ModelRouteTuning | null) => {
    setTuning(next);
    try {
      const state = await saveModelRouteTuning(next);
      setTuning(state.tuning);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  const applyPreset = (preset: PresetId) => {
    if (!routes) return;
    const targets = presetTargets(preset, providers);
    if (targets.length === 0) {
      setError(t('settings.pools.preset.empty'));
      return;
    }
    void persist({ ...routes, [PRESET_ROUTE_IDS[preset]]: { kind: 'editable', route: { targets, autonomy: 'rules', selection: 'ordered' } } });
    setExpandedId(PRESET_ROUTE_IDS[preset]);
  };

  // A pool needs a target, or a pattern that picks models, to be saved, so a new pool stays a local draft until it has one.
  const addPool = () => {
    const id = newId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    if (!id || !routes || routes[id] || drafts[id]) return;
    setDrafts((current) => ({ ...current, [id]: { targets: [] } }));
    setNewId('');
    setExpandedId(id);
  };

  const withoutKey = <T,>(record: Record<string, T>, id: string): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== id));

  const recentDecisions = React.useMemo(
    () => Object.values(decisions).sort((a, b) => b.at - a.at).slice(0, 8),
    [decisions],
  );

  const draftEntries = Object.fromEntries(
    Object.entries(drafts).map(([id, route]): [string, ModelRouteEntry] => [id, { kind: 'editable', route }]),
  );

  return (
    <SettingsSection title={t('settings.pools.title')}>
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.description')}</p>
        {error ? <p className={SETTINGS_HELPER_CLASS}>{error}</p> : null}
        {refusal ? (
          <div role="alert" className="space-y-2 rounded-lg bg-[var(--status-warning-background)] p-3">
            <p className="typography-ui-label font-medium text-[var(--status-warning-text)]">{t('settings.pools.refused')}</p>
            <PoolProblemLines problems={Object.values(refusal.problems).flat()} className="text-[var(--status-warning-text)]" />
            <Button size="sm" variant="outline" onClick={() => void persist(refusal.routes, true)} disabled={saving}>
              {t('settings.pools.saveAnyway')}
            </Button>
          </div>
        ) : null}
        {routes === null ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.loading')}</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <Button key={preset.id} size="sm" variant="outline" onClick={() => applyPreset(preset.id)} title={t(preset.infoKey)}>
                  {t(preset.titleKey)}
                </Button>
              ))}
            </div>
            <div className="divide-y divide-border/40 border-y border-border/40">
              {Object.entries({ ...routes, ...draftEntries }).map(([id, entry]) => {
                const isDraft = id in drafts;
                return (
                  <PoolRow
                    key={id}
                    id={id}
                    entry={entry}
                    problems={problems[id] ?? []}
                    otherPoolIDs={entry.kind === 'editable'
                      ? Object.keys(routes).filter(
                        (other) => other !== id && !(entry.route.targets ?? []).some((target) => routeReferenceID(target) === other),
                      )
                      : []}
                    expanded={expandedId === id}
                    onToggle={() => setExpandedId((current) => (current === id ? null : id))}
                    onChange={(next) => {
                      if (isDraft && next.kind === 'editable' && !hasModelSource(next.route)) {
                        setDrafts((current) => ({ ...current, [id]: next.route }));
                        return;
                      }
                      if (isDraft) setDrafts((current) => withoutKey(current, id));
                      void persist({ ...routes, [id]: next });
                    }}
                    onRemove={() => {
                      if (isDraft) {
                        setDrafts((current) => withoutKey(current, id));
                        return;
                      }
                      void persist(withoutKey(routes, id));
                    }}
                  />
                );
              })}
            </div>
            <SettingsFieldRow label={t('settings.pools.addLabel')} settingsItem="pools.add-pool">
              <div className="flex w-full min-w-0 items-center gap-2">
                <Input
                  value={newId}
                  onChange={(event) => setNewId(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') addPool(); }}
                  placeholder={t('settings.pools.addPlaceholder')}
                  aria-label={t('settings.pools.addLabel')}
                  className="h-8 rounded-md px-3 min-w-0 flex-1"
                  maxLength={64}
                />
                <Button size="sm" variant="outline" onClick={addPool} disabled={newId.trim().length === 0 || saving}>
                  {t('settings.pools.add')}
                </Button>
              </div>
            </SettingsFieldRow>
            <div className="space-y-2">
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.tuning.title')}</p>
              {tuning === UNREADABLE_TUNING ? (
                <p className="typography-meta text-[var(--status-warning)]">{t('settings.pools.tuning.unreadable')}</p>
              ) : (
                <RouteTuningFields tuning={tuning} onSave={(next) => void saveTuning(next)} />
              )}
            </div>
            <PoolTelemetry />
            {recentDecisions.length > 0 ? (
              <div className="space-y-1">
                <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.recentDecisions')}</p>
                {recentDecisions.map((decision) => (
                  <p key={`${decision.sessionId}-${decision.at}`} className="typography-meta text-muted-foreground truncate">
                    {decision.category ?? t('settings.pools.decisionFallback')}
                    {decision.providerID ? ` → ${decision.providerID}/${decision.modelID ?? ''}` : ''}
                    {` (${decision.reason})`}
                  </p>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </SettingsSection>
  );
};
