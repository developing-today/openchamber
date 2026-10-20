import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SettingsStackedField, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { GoalWriterBuiltinPromptResult, GoalWriterPromptRewriteResult } from '@/lib/goalWriter';
import { useI18n } from '@/lib/i18n';
import { SESSION_GOAL_WRITER_PROMPT_CHAR_LIMIT } from '@/lib/sessionGoalMetadata';
import { cn } from '@/lib/utils';

type RewriteState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'failed'; reason: string }
  | { status: 'proposed'; current: string; proposed: string; model: string };

interface GoalWriterPromptEditorProps {
  /** The saved prompt; empty means the built-in one. */
  stored: string;
  onStore: (prompt: string) => void;
  /** The built-in prompt and rules from the server; null while they load. */
  builtin: GoalWriterBuiltinPromptResult | null;
  /** Asks the goal writer's model for a new prompt; a failure resolves with its reason. */
  rewrite: (prompt: string, instruction: string, signal: AbortSignal) => Promise<GoalWriterPromptRewriteResult>;
  disabled: boolean;
}

const PROMPT_TEXT_CLASS = 'oc-tile max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 typography-meta text-foreground';

/**
 * The goal writer's prompt in Settings → Chat → Goal: the prompt in use,
 * editable, with Reset to default while it differs from the built-in one; and
 * "Describe a change", whose rewrite is shown next to the current prompt
 * until the user applies or discards it. The caller owns where the prompt is
 * saved and how the built-in one and a rewrite are fetched.
 */
export const GoalWriterPromptEditor: React.FC<GoalWriterPromptEditorProps> = ({ stored, onStore, builtin, rewrite, disabled }) => {
  const { t } = useI18n();
  // What the user typed, reset or applied; until then the field shows what is saved.
  const [draft, setDraft] = React.useState<string | null>(null);
  const [instruction, setInstruction] = React.useState('');
  const [rewriteState, setRewriteState] = React.useState<RewriteState>({ status: 'idle' });
  const controllerRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => controllerRef.current?.abort(), []);

  const builtinPrompt = builtin?.ok ? builtin.prompt : null;
  const text = draft ?? (stored || builtinPrompt || '');
  const loading = builtin === null && stored === '' && draft === null;
  // The built-in prompt is saved as empty, so a newer release's text replaces it.
  const toStored = (value: string): string => (
    value.trim() === '' || value.trim() === builtinPrompt?.trim() ? '' : value
  );
  const custom = toStored(text) !== '';
  // Nothing to compare with until the server has answered.
  const canReset = builtin !== null && text.trim() !== (builtinPrompt ?? '').trim();
  const working = rewriteState.status === 'working';
  const proposal = rewriteState.status === 'proposed' ? rewriteState : null;

  const edit = (value: string) => {
    setDraft(value);
    onStore(toStored(value));
  };

  const reset = () => {
    setDraft(builtinPrompt ?? '');
    onStore('');
  };

  const editInstruction = (value: string) => {
    setInstruction(value);
    if (rewriteState.status === 'failed') setRewriteState({ status: 'idle' });
  };

  const submitChange = async () => {
    const change = instruction.trim();
    if (!change || working) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRewriteState({ status: 'working' });
    let result: GoalWriterPromptRewriteResult;
    try {
      result = await rewrite(text, change, controller.signal);
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (controller.signal.aborted) return;
    controllerRef.current = null;
    setRewriteState(result.ok
      ? { status: 'proposed', current: text || builtinPrompt || '', proposed: result.prompt, model: `${result.providerID}/${result.modelID}` }
      : { status: 'failed', reason: result.message });
  };

  const apply = (proposed: string) => {
    edit(proposed);
    setInstruction('');
    setRewriteState({ status: 'idle' });
  };

  const failure = rewriteState.status === 'failed'
    ? t('settings.openchamber.visual.goal.writer.changeFailed', { reason: rewriteState.reason })
    : '';

  return (
    <SettingsStackedField
      label={t('settings.openchamber.visual.goal.writer.promptLabel')}
      info={t('settings.openchamber.visual.goal.writer.promptInfo')}
      settingsItem="chat.session-goal-writer-prompt"
      controlClassName="w-full max-w-none flex-col items-stretch"
    >
      {proposal ? (
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.openchamber.visual.goal.writer.proposalCurrent')}</p>
              <div className={PROMPT_TEXT_CLASS}>{proposal.current}</div>
            </div>
            <div className="min-w-0 space-y-1">
              <p className={cn(SETTINGS_HELPER_CLASS, 'truncate')} title={proposal.model}>
                {t('settings.openchamber.visual.goal.writer.proposalProposed', { model: proposal.model })}
              </p>
              <div className={PROMPT_TEXT_CLASS}>{proposal.proposed}</div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setRewriteState({ status: 'idle' })}>
              {t('settings.openchamber.visual.goal.writer.proposalDiscard')}
            </Button>
            <Button size="sm" onClick={() => apply(proposal.proposed)} disabled={disabled}>
              {t('settings.openchamber.visual.goal.writer.proposalApply')}
            </Button>
          </div>
        </div>
      ) : (
        <Textarea
          value={text}
          onChange={(event) => edit(event.target.value)}
          placeholder={loading ? t('common.loading') : t('settings.openchamber.visual.goal.writer.promptEmpty')}
          aria-label={t('settings.openchamber.visual.goal.writer.promptLabel')}
          disabled={disabled || loading}
          maxLength={SESSION_GOAL_WRITER_PROMPT_CHAR_LIMIT}
          rows={12}
          className="typography-meta"
        />
      )}
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className={SETTINGS_HELPER_CLASS}>
          {custom
            ? t('settings.openchamber.visual.goal.writer.promptCustom')
            : t('settings.openchamber.visual.goal.writer.promptBuiltin')}
        </span>
        {canReset && !proposal ? (
          <Button size="sm" variant="outline" onClick={reset} disabled={disabled}>
            {t('settings.openchamber.visual.goal.writer.promptReset')}
          </Button>
        ) : null}
      </div>
      {builtin?.ok ? (
        <p className={cn(SETTINGS_HELPER_CLASS, 'whitespace-pre-line')}>
          {`${t('settings.openchamber.visual.goal.writer.promptRules')}\n${builtin.rules}`}
        </p>
      ) : null}
      {builtin && !builtin.ok ? (
        <p className="typography-meta text-[var(--status-error)]">
          {t('settings.openchamber.visual.goal.writer.promptLoadFailed', { reason: builtin.message })}
        </p>
      ) : null}
      <form
        className="flex items-center gap-2"
        aria-busy={working || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void submitChange();
        }}
      >
        <Input
          value={instruction}
          onChange={(event) => editInstruction(event.target.value)}
          placeholder={t('settings.openchamber.visual.goal.writer.changePlaceholder')}
          aria-label={t('settings.openchamber.visual.goal.writer.changePlaceholder')}
          disabled={disabled || working}
          className="min-w-0 flex-1"
        />
        <Button type="submit" variant="outline" disabled={disabled || working || !instruction.trim()}>
          <Icon name={working ? 'loader-4' : 'sparkling'} className={cn('size-3.5', working && 'animate-spin')} aria-hidden="true" />
          {t('settings.openchamber.visual.goal.writer.changeSubmit')}
        </Button>
      </form>
      {/* A reserved line, so a failure never moves what is below it. */}
      <p className="min-h-4 truncate typography-meta text-[var(--status-error)]" title={failure || undefined} aria-live="polite">
        {failure}
      </p>
    </SettingsStackedField>
  );
};
