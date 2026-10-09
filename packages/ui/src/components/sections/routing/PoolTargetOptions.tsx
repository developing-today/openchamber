import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import type { ModelRouteTarget } from '@/lib/routing/modelRoutesApi';
import { epochToLocalInput, targetOptions, withTargetOptions, type TargetOptions } from '@/lib/routing/poolAdvanced';

export const CommitInput: React.FC<{
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}> = ({ label, value, placeholder, onCommit }) => {
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (text: string) => {
    setDraft(text);
    const next = text.trim();
    if (next !== value) onCommit(next);
  };

  return (
    <Input
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      maxLength={200}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(event.currentTarget.value);
      }}
      className="h-8 min-w-0 rounded-md px-2"
    />
  );
};

/** Per-target options: when the target leaves the pool, its default variant, and variant remaps. */
export const PoolTargetOptions: React.FC<{
  target: ModelRouteTarget;
  onChange: (target: ModelRouteTarget) => void;
}> = ({ target, onChange }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const newFromRef = React.useRef<HTMLInputElement>(null);
  const newToRef = React.useRef<HTMLInputElement>(null);
  const options = targetOptions(target);
  const remaps = Object.entries(options.variants ?? {});

  const save = (next: TargetOptions) => onChange(withTargetOptions(target, next));

  const setRemaps = (variants: Record<string, string>) =>
    save({ ...options, variants: Object.keys(variants).length > 0 ? variants : undefined });

  const replaceRemap = (oldFrom: string, from: string, to: string) => {
    const next: Record<string, string> = { ...(options.variants ?? {}) };
    delete next[oldFrom];
    if (from && to) next[from] = to;
    setRemaps(next);
  };

  const addRemap = () => {
    const from = newFromRef.current?.value.trim() ?? '';
    const to = newToRef.current?.value.trim() ?? '';
    if (!from || !to) return;
    setRemaps({ ...(options.variants ?? {}), [from]: to });
    if (newFromRef.current) newFromRef.current.value = '';
    if (newToRef.current) newToRef.current.value = '';
  };

  const heading = 'typography-meta text-muted-foreground';

  return (
    <div className="space-y-2 pl-2">
      <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? t('settings.pools.target.hideOptions') : t('settings.pools.target.options')}
      </Button>
      {open ? (
        <div className="space-y-3 rounded-md border border-border/40 p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1">
              <span className={heading}>{t('settings.pools.target.until')}</span>
              <Input
                type="datetime-local"
                value={epochToLocalInput(options.until)}
                onChange={(event) =>
                  save({ ...options, until: event.target.value ? new Date(event.target.value).getTime() : undefined })
                }
                className="h-8 min-w-0 rounded-md px-2"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className={heading}>{t('settings.pools.target.defaultVariant')}</span>
              <CommitInput
                label={t('settings.pools.target.defaultVariant')}
                value={options.defaultVariant ?? ''}
                placeholder={t('settings.pools.target.defaultVariantPlaceholder')}
                onCommit={(next) => save({ ...options, defaultVariant: next || undefined })}
              />
            </label>
          </div>
          <div className="space-y-2">
            <p className="typography-ui-label font-medium text-foreground">{t('settings.pools.target.remaps')}</p>
            {remaps.map(([from, to]) => (
              <div key={from} className="flex min-w-0 items-center gap-2">
                <CommitInput label={t('settings.pools.target.remapFrom')} value={from} onCommit={(next) => replaceRemap(from, next, to)} />
                <span className={heading}>→</span>
                <CommitInput label={t('settings.pools.target.remapTo')} value={to} onCommit={(next) => replaceRemap(from, from, next)} />
                <Button size="sm" variant="ghost" onClick={() => replaceRemap(from, '', '')}>
                  {t('settings.pools.target.removeRemap')}
                </Button>
              </div>
            ))}
            <div className="flex min-w-0 items-center gap-2">
              <Input
                ref={newFromRef}
                placeholder={t('settings.pools.target.remapFrom')}
                aria-label={t('settings.pools.target.remapFrom')}
                className="h-8 min-w-0 flex-1 rounded-md px-2"
                maxLength={200}
              />
              <span className={heading}>→</span>
              <Input
                ref={newToRef}
                placeholder={t('settings.pools.target.remapTo')}
                aria-label={t('settings.pools.target.remapTo')}
                className="h-8 min-w-0 flex-1 rounded-md px-2"
                maxLength={200}
              />
              <Button size="sm" variant="outline" onClick={addRemap}>
                {t('settings.pools.target.addRemap')}
              </Button>
            </div>
            <p className={heading}>{t('settings.pools.target.remapsInfo')}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
};
