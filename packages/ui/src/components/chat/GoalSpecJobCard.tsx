import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isAutoModel } from '@/lib/routing/autoModel';
import {
  goalSpecJobChoices,
  useGoalSpecJobStore,
  type GoalSpecJob,
  type GoalSpecJobChoice,
  type GoalSpecJobChoices,
} from '@/stores/goalSpecJobStore';
import { useUIStore } from '@/stores/useUIStore';
import { useChatColumnTakesPrompts } from './chatColumnSession';
import { GoalWriterPicker } from './GoalWriterPicker';
import { takeGoalSpecJobBack } from './goalSpecJobEdit';
import { sendGoalSpecJob } from './goalSpecJobSend';

interface GoalSpecJobCardProps {
  sessionId: string;
  /** The column the card lines up with: the transcript's, or the composer's. */
  className?: string;
}

type SendMode = Extract<GoalSpecJobChoice, { kind: 'spec' }>['sendMode'];

const SEND_LABEL_KEYS = {
  'with-message': 'chat.goal.writer.action.sendWithMessage',
  'goal-as-message': 'chat.goal.writer.action.sendGoalAsMessage',
} as const satisfies Record<SendMode, string>;

const otherSendMode = (mode: SendMode): SendMode => (mode === 'with-message' ? 'goal-as-message' : 'with-message');

/**
 * The goal writer's card for one session: what the server does with a message
 * sent through the goal writer, and the choices that send it. ChatContainer
 * shows it as the last row of the transcript, or above the composer while the
 * session has no transcript yet. A chat that takes no prompts shows no card:
 * it has no composer to send the message from or take it back to. The job is
 * the server's, so leaving the session changes nothing and the card is there
 * on return.
 */
export const GoalSpecJobCard = React.memo(function GoalSpecJobCard({ sessionId, className }: GoalSpecJobCardProps) {
  const job = useGoalSpecJobStore((state) => state.jobs[sessionId] ?? null);
  const takesPrompts = useChatColumnTakesPrompts();
  if (!job || !takesPrompts) return null;
  return (
    <div className={className}>
      <GoalSpecJobCardBody key={job.id} job={job} />
    </div>
  );
});

function GoalSpecJobCardBody({ job }: { job: GoalSpecJob }) {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  // The goal length limit from Settings; the server writes the spec within it.
  const charLimit = useUIStore((state) => state.sessionGoalObjectiveCharLimit);
  // An action from this card is on its way; the job's own `sending` covers sends from anywhere.
  const [acting, setActing] = React.useState(false);
  const editedSpec = useGoalSpecJobStore((state) => {
    const edit = state.specEdits[job.id];
    return edit && edit.attempt === job.attempt ? edit.spec : null;
  });
  const spec = editedSpec ?? job.spec ?? '';
  const trimmedSpec = spec.trim();
  // The writer and the length limit for this spec: Write again uses them, and a
  // send carries the limit to the goal it starts.
  const choiceEdit = useGoalSpecJobStore((state) => state.choiceEdits[job.id]);
  const choices = goalSpecJobChoices(job, choiceEdit);
  const setChoices = (next: GoalSpecJobChoices) => useGoalSpecJobStore.getState().setChoiceEdit(job, next);
  const overLimit = !choices.ignoreLimit && spec.length > charLimit;
  const limitNote = overLimit
    ? t('chat.goal.dialog.overLimit', { limit: charLimit })
    : (choices.ignoreLimit ? t('chat.goal.dialog.limitIgnored') : '');
  const busy = acting || job.sending;
  // A send waiting for the agent's turn to end goes out by itself; only Back to edit changes it.
  const waiting = job.waiting === true && !job.sending;
  const locked = busy || waiting;

  const run = (action: () => Promise<void>, failureKey: 'chat.goal.writer.toast.sendFailed' | 'chat.goal.writer.toast.actionFailed') => {
    if (busy) return;
    setActing(true);
    void action()
      .catch((error) => {
        toast.error(t(failureKey, { reason: error instanceof Error ? error.message : String(error) }));
      })
      .finally(() => setActing(false));
  };
  const send = (choice: GoalSpecJobChoice) => run(
    () => sendGoalSpecJob(job, { ...choice, ignoreLimit: choices.ignoreLimit }),
    'chat.goal.writer.toast.sendFailed',
  );
  const redo = () => run(() => useGoalSpecJobStore.getState().redoJob(job, choices), 'chat.goal.writer.toast.actionFailed');
  const dismiss = () => run(() => useGoalSpecJobStore.getState().dismissJob(job), 'chat.goal.writer.toast.actionFailed');
  const backToEdit = () => run(() => takeGoalSpecJobBack(job), 'chat.goal.writer.toast.actionFailed');

  const title = job.trigger === 'auto-create' && job.review
    ? t('chat.goal.writer.card.titleAutoCreate')
    : t('chat.goal.writer.card.title');

  if (job.status === 'sent') {
    const outcome = job.outcome;
    const sentText = !outcome
      ? t('chat.goal.writer.card.sent')
      : outcome.kind === 'spec'
        ? t(outcome.sendMode === 'with-message' ? 'chat.goal.writer.card.sentWithMessage' : 'chat.goal.writer.card.sentGoalAsMessage')
        : t(outcome.withGoal ? 'chat.goal.writer.card.sentAsGoal' : 'chat.goal.writer.card.sentWithoutGoal');
    return (
      <section aria-label={title} className="oc-tile min-w-0 rounded-xl py-1 ps-3 pe-1">
        <div className="flex min-w-0 items-center gap-2">
          {/* The sentence wraps: it is the row's whole message, and a phone cut it off mid-sentence. */}
          <p className="flex min-w-0 flex-1 items-start gap-2 typography-meta text-foreground">
            <Icon name="check" className="mt-0.5 size-3.5 shrink-0 text-[var(--status-success)]" aria-hidden="true" />
            <span className="min-w-0 break-words" title={job.message.content}>{sentText}</span>
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={dismiss}
            disabled={busy}
            aria-label={t('chat.goal.writer.card.dismissAria')}
            title={t('chat.goal.writer.card.dismissAria')}
            className="shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            <Icon name="close" className="size-4" aria-hidden="true" />
          </Button>
        </div>
        {job.warning ? (
          <p className="typography-micro break-words pb-1 pe-2 text-[var(--status-warning-text)]">
            {t('chat.goal.writer.card.sentWarning', { reason: job.warning })}
          </p>
        ) : null}
      </section>
    );
  }

  const writerText = !job.writer.providerID || !job.writer.modelID
    ? t('chat.goal.writer.card.writerSmallModel')
    : (job.writer.source === 'settings' || job.writer.source === 'picked') && job.writer.variant
      ? t('chat.goal.writer.card.writerEffort', { model: `${job.writer.providerID}/${job.writer.modelID}`, effort: job.writer.variant })
      : t('chat.goal.writer.card.writerDefaultEffort', { model: `${job.writer.providerID}/${job.writer.modelID}` });
  const preview = job.message.content.trim().split('\n', 1)[0] ?? '';
  const writing = job.status === 'writing';
  const ready = job.status === 'ready';
  // A failed "Send original" stops the write, so a job without a spec can have
  // failed at the send. A server that does not name the step failed a send
  // only from a written spec.
  const sendFailed = job.failedStep ? job.failedStep === 'send' : ready;
  // Without a spec, the send that failed was of the message as typed, so Try
  // again sends it again; after a failed write it writes again.
  const retry = !ready && sendFailed ? () => send({ kind: 'original' }) : redo;
  const sendOriginalLabel = job.trigger === 'armed'
    ? t('chat.goal.writer.action.useMessage')
    : t('chat.goal.writer.action.sendWithoutGoal');
  // Auto runs on no provider, so a session on Auto names no model the writer could start from.
  const sessionModel = isAutoModel(job.sendConfig.providerID, job.sendConfig.modelID)
    ? null
    : { providerID: job.sendConfig.providerID, modelID: job.sendConfig.modelID };

  return (
    <section aria-label={title} className="oc-tile rounded-xl px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon name="sparkling" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 typography-ui-label font-medium text-foreground">{title}</span>
        <span aria-hidden="true" className="shrink-0 typography-meta text-muted-foreground">·</span>
        <span className="min-w-0 truncate typography-meta text-muted-foreground" title={writerText}>{writerText}</span>
      </div>
      {preview ? (
        <p className="mt-0.5 truncate typography-meta text-muted-foreground" title={job.message.content}>{preview}</p>
      ) : null}

      {/* The same row in every state of an open job, so the card keeps its shape as the job moves on. */}
      <div className="mt-2 flex items-start justify-between gap-2">
        <GoalWriterPicker
          directory={job.directory}
          sessionModel={sessionModel}
          value={choices.writerChoice}
          onChange={(writerChoice) => setChoices({ ...choices, writerChoice })}
          disabled={locked}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-7 w-7 shrink-0 px-0" aria-label={t('chat.goal.dialog.moreAria')} disabled={locked}>
              <Icon name="more-2" className="size-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setChoices({ ...choices, ignoreLimit: !choices.ignoreLimit })} className="flex items-center justify-between gap-4">
              <span>{t('chat.goal.dialog.ignoreLimit')}</span>
              {choices.ignoreLimit ? <Icon name="check" className="size-4 text-primary" aria-hidden="true" /> : null}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {job.composerOnly && !waiting && !job.sending ? (
        <p className="mt-2 flex items-start gap-1.5 typography-meta text-muted-foreground">
          <Icon name="attachment-2" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{t('chat.goal.writer.card.waitsForYou')}</span>
        </p>
      ) : null}

      {job.sending || waiting || writing ? (
        <div className="mt-2 flex items-center gap-2" role="status">
          {waiting ? (
            <Icon name="time" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          )}
          <span className="typography-meta text-foreground">
            {job.sending
              ? t('chat.goal.writer.card.sending')
              : waiting ? t('chat.goal.writer.card.waitingForTurn') : t('chat.goal.writer.card.writing')}
          </span>
          {!job.sending && !waiting && !job.review && !job.composerOnly ? (
            <span className="typography-meta text-muted-foreground">{t('chat.goal.writer.card.sendsWhenWritten')}</span>
          ) : null}
        </div>
      ) : null}

      {job.error && !job.sending && !waiting ? (
        <div className="mt-2 rounded-lg bg-[var(--status-error-background)] px-2.5 py-1.5" role="alert">
          <p className="typography-meta font-medium text-[var(--status-error-text)]">
            {sendFailed ? t('chat.goal.writer.card.sendFailed') : t('chat.goal.writer.card.failed')}
          </p>
          <p className="typography-meta break-words text-muted-foreground">{job.error}</p>
        </div>
      ) : null}

      {ready ? (
        <div className="mt-2 space-y-1">
          <Textarea
            value={spec}
            onChange={(event) => useGoalSpecJobStore.getState().setSpecEdit(job, event.target.value)}
            rows={isMobile ? 5 : 8}
            disabled={locked}
            aria-label={t('chat.goal.writer.card.specAria')}
            endSlot={(
              <span
                className={overLimit ? 'typography-micro tabular-nums text-status-warning' : 'typography-micro tabular-nums text-muted-foreground/70'}
                aria-label={t('chat.goal.counter.aria')}
              >
                {choices.ignoreLimit ? spec.length : `${spec.length}/${charLimit}`}
              </span>
            )}
          />
          {/* One line kept for it, so the field does not jump as the text crosses the limit. */}
          <p className="min-h-4 truncate typography-micro text-muted-foreground" title={limitNote || undefined}>{limitNote}</p>
          <p className="typography-meta text-muted-foreground">{t('chat.goal.writer.card.reviewHint')}</p>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={backToEdit} disabled={busy}>
          <Icon name="arrow-go-back" className="size-3.5" aria-hidden="true" />
          {t('chat.goal.writer.action.backToEdit')}
        </Button>
        {!writing ? (
          <Button type="button" variant="ghost" size="sm" onClick={retry} disabled={locked}>
            <Icon name="restart" className="size-3.5" aria-hidden="true" />
            {ready ? t('chat.goal.writer.action.rewrite') : t('chat.goal.writer.action.retry')}
          </Button>
        ) : null}
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <Button type="button" variant={ready ? 'ghost' : 'outline'} size="sm" onClick={() => send({ kind: 'original' })} disabled={locked}>
            {sendOriginalLabel}
          </Button>
          {ready ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={locked || !trimmedSpec}
                onClick={() => send({ kind: 'spec', sendMode: otherSendMode(job.sendMode), spec: trimmedSpec })}
              >
                {t(SEND_LABEL_KEYS[otherSendMode(job.sendMode)])}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={locked || !trimmedSpec}
                onClick={() => send({ kind: 'spec', sendMode: job.sendMode, spec: trimmedSpec })}
              >
                {t(SEND_LABEL_KEYS[job.sendMode])}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
