import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { SESSION_GOAL_OBJECTIVE_CHAR_LIMIT } from '@/lib/sessionGoalMetadata';
import { useGoalSpecJobStore, type GoalSpecJob, type GoalSpecJobChoice } from '@/stores/goalSpecJobStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useUIStore } from '@/stores/useUIStore';
import { useInputStore } from '@/sync/input-store';
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
 * session has no transcript yet. The job is the server's, so leaving the
 * session changes nothing and the card is there on return.
 */
export const GoalSpecJobCard = React.memo(function GoalSpecJobCard({ sessionId, className }: GoalSpecJobCardProps) {
  const job = useGoalSpecJobStore((state) => state.jobs[sessionId] ?? null);
  if (!job) return null;
  return (
    <div className={className}>
      <GoalSpecJobCardBody key={job.id} job={job} />
    </div>
  );
});

function GoalSpecJobCardBody({ job }: { job: GoalSpecJob }) {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  // An action from this card is on its way; the job's own `sending` covers sends from anywhere.
  const [acting, setActing] = React.useState(false);
  const editedSpec = useGoalSpecJobStore((state) => {
    const edit = state.specEdits[job.id];
    return edit && edit.attempt === job.attempt ? edit.spec : null;
  });
  const spec = editedSpec ?? job.spec ?? '';
  const trimmedSpec = spec.trim();
  const busy = acting || job.sending;

  const run = (action: () => Promise<void>, failureKey: 'chat.goal.writer.toast.sendFailed' | 'chat.goal.writer.toast.actionFailed') => {
    if (busy) return;
    setActing(true);
    void action()
      .catch((error) => {
        toast.error(t(failureKey, { reason: error instanceof Error ? error.message : String(error) }));
      })
      .finally(() => setActing(false));
  };
  const send = (choice: GoalSpecJobChoice) => run(() => sendGoalSpecJob(job, choice), 'chat.goal.writer.toast.sendFailed');
  const redo = () => run(() => useGoalSpecJobStore.getState().redoJob(job), 'chat.goal.writer.toast.actionFailed');
  const dismiss = () => run(() => useGoalSpecJobStore.getState().dismissJob(job), 'chat.goal.writer.toast.actionFailed');
  // The job ends and its message, files and chips included, goes back to
  // this session's composer; an armed goal is armed again, as before the send.
  const backToEdit = () => run(async () => {
    const message = await useGoalSpecJobStore.getState().editJob(job);
    useInputStore.getState().requestComposerEdit({
      runtimeKey: getRuntimeKey(),
      sessionId: job.sessionId,
      content: message.content,
      attachments: message.attachments,
      context: message.context,
    });
    if (job.trigger === 'armed') useSessionGoalArmStore.getState().setArmed(true);
  }, 'chat.goal.writer.toast.actionFailed');

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
          <Icon name="check" className="size-3.5 shrink-0 text-[var(--status-success)]" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate typography-meta text-foreground" title={job.message.content}>{sentText}</span>
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
    : job.writer.source === 'settings' && job.writer.variant
      ? t('chat.goal.writer.card.writerEffort', { model: `${job.writer.providerID}/${job.writer.modelID}`, effort: job.writer.variant })
      : t('chat.goal.writer.card.writerDefaultEffort', { model: `${job.writer.providerID}/${job.writer.modelID}` });
  const preview = job.message.content.trim().split('\n', 1)[0] ?? '';
  const writing = job.status === 'writing';
  const ready = job.status === 'ready';
  // A failed "Send original" stops the write, so a job without a spec can have
  // failed at the send. A server that does not name the step failed a send
  // only from a written spec.
  const sendFailed = job.failedStep ? job.failedStep === 'send' : ready;
  const sendOriginalLabel = job.trigger === 'armed'
    ? t('chat.goal.writer.action.useMessage')
    : t('chat.goal.writer.action.sendWithoutGoal');

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

      {job.composerOnly ? (
        <p className="mt-2 flex items-start gap-1.5 typography-meta text-muted-foreground">
          <Icon name="attachment-2" className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{t('chat.goal.writer.card.waitsForYou')}</span>
        </p>
      ) : null}

      {job.sending || writing ? (
        <div className="mt-2 flex items-center gap-2" role="status">
          <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="typography-meta text-foreground">
            {job.sending ? t('chat.goal.writer.card.sending') : t('chat.goal.writer.card.writing')}
          </span>
          {!job.sending && !job.review && !job.composerOnly ? (
            <span className="typography-meta text-muted-foreground">{t('chat.goal.writer.card.sendsWhenWritten')}</span>
          ) : null}
        </div>
      ) : null}

      {job.error && !job.sending ? (
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
            maxLength={SESSION_GOAL_OBJECTIVE_CHAR_LIMIT}
            rows={isMobile ? 5 : 8}
            disabled={busy}
            aria-label={t('chat.goal.writer.card.specAria')}
            endSlot={(
              <span className="typography-micro tabular-nums text-muted-foreground/70" aria-label={t('chat.goal.counter.aria')}>
                {spec.length}/{SESSION_GOAL_OBJECTIVE_CHAR_LIMIT}
              </span>
            )}
          />
          <p className="typography-meta text-muted-foreground">{t('chat.goal.writer.card.reviewHint')}</p>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={backToEdit} disabled={busy}>
          <Icon name="arrow-go-back" className="size-3.5" aria-hidden="true" />
          {t('chat.goal.writer.action.backToEdit')}
        </Button>
        {!writing ? (
          <Button type="button" variant="ghost" size="sm" onClick={redo} disabled={busy}>
            <Icon name="restart" className="size-3.5" aria-hidden="true" />
            {ready ? t('chat.goal.writer.action.rewrite') : t('chat.goal.writer.action.retry')}
          </Button>
        ) : null}
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <Button type="button" variant={ready ? 'ghost' : 'outline'} size="sm" onClick={() => send({ kind: 'original' })} disabled={busy}>
            {sendOriginalLabel}
          </Button>
          {ready ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || !trimmedSpec}
                onClick={() => send({ kind: 'spec', sendMode: otherSendMode(job.sendMode), spec: trimmedSpec })}
              >
                {t(SEND_LABEL_KEYS[otherSendMode(job.sendMode)])}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy || !trimmedSpec}
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
