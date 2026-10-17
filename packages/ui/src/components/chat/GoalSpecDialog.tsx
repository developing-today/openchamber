import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import type { GoalSpecResult, GoalSubmitChoice, GoalWriterTrigger } from '@/lib/goalWriter';
import { SESSION_GOAL_OBJECTIVE_CHAR_LIMIT } from '@/lib/sessionGoalMetadata';
import { useI18n } from '@/lib/i18n';
import { useUIStore, type SessionGoalWriterSendMode } from '@/stores/useUIStore';

export interface GoalSpecDialogRequest {
  /** A new id starts a new writing run. */
  id: number;
  trigger: GoalWriterTrigger;
  /** False sends the spec as soon as it is written; the dialog only shows progress or a failure. */
  review: boolean;
  defaultSendMode: SessionGoalWriterSendMode;
  write: (signal: AbortSignal) => Promise<GoalSpecResult>;
}

interface GoalSpecDialogProps {
  /** Non-null while a send waits on the goal writer. */
  request: GoalSpecDialogRequest | null;
  onCancel: () => void;
  onSubmit: (choice: GoalSubmitChoice) => void;
}

type WriterState =
  | { status: 'writing' }
  | { status: 'ready'; model: string }
  | { status: 'failed'; reason: string };

const SEND_LABEL_KEYS = {
  'with-message': 'chat.goal.writer.action.sendWithMessage',
  'goal-as-message': 'chat.goal.writer.action.sendGoalAsMessage',
} as const satisfies Record<SessionGoalWriterSendMode, string>;

const otherSendMode = (mode: SessionGoalWriterSendMode): SessionGoalWriterSendMode => (
  mode === 'with-message' ? 'goal-as-message' : 'with-message'
);

/**
 * The goal writer's step between pressing send and the message going out:
 * the spec is written, shown for approval (or sent at once when review is
 * off), and sent with the typed message or in its place. The composer keeps
 * the message until a choice is made, so closing the dialog loses nothing.
 */
export function GoalSpecDialog({ request, onCancel, onSubmit }: GoalSpecDialogProps) {
  const isMobile = useUIStore((state) => state.isMobile);
  if (!request) return null;
  const body = <GoalSpecDialogBody key={request.id} request={request} mobile={isMobile} onCancel={onCancel} onSubmit={onSubmit} />;
  if (isMobile) return body;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-xl">{body}</DialogContent>
    </Dialog>
  );
}

function GoalSpecDialogBody({
  request,
  mobile,
  onCancel,
  onSubmit,
}: { request: GoalSpecDialogRequest; mobile: boolean; onCancel: () => void; onSubmit: (choice: GoalSubmitChoice) => void }) {
  const { t } = useI18n();
  const [state, setState] = React.useState<WriterState>({ status: 'writing' });
  const [spec, setSpec] = React.useState('');
  const [attempt, setAttempt] = React.useState(0);
  const onSubmitRef = React.useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  React.useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'writing' });
    const run = async () => {
      let result: GoalSpecResult;
      try {
        result = await request.write(controller.signal);
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setState({ status: 'failed', reason: result.message });
        return;
      }
      if (!request.review) {
        onSubmitRef.current({ kind: 'spec', spec: result.spec, sendMode: request.defaultSendMode });
        return;
      }
      setSpec(result.spec);
      setState({ status: 'ready', model: `${result.providerID}/${result.modelID}` });
    };
    void run();
    return () => controller.abort();
  }, [attempt, request]);

  const trimmedSpec = spec.trim();
  const skip: GoalSubmitChoice = request.trigger === 'armed' ? { kind: 'unchanged' } : { kind: 'none' };
  const skipLabel = request.trigger === 'armed'
    ? t('chat.goal.writer.action.useMessage')
    : t('chat.goal.writer.action.sendWithoutGoal');
  const secondaryMode = otherSendMode(request.defaultSendMode);
  const title = request.trigger === 'auto-create' && request.review
    ? t('chat.goal.writer.dialog.titleAutoCreate')
    : t('chat.goal.writer.dialog.title');

  const content = (
    <div className="space-y-3">
      {state.status === 'writing' ? (
        <div className="flex items-start gap-2 py-2" role="status">
          <Icon name="loader-4" className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          <div className="space-y-1">
            <p className="typography-ui-label text-foreground">{t('chat.goal.writer.dialog.writing')}</p>
            {request.review ? null : (
              <p className="typography-meta text-muted-foreground">{t('chat.goal.writer.dialog.sendsWhenWritten')}</p>
            )}
          </div>
        </div>
      ) : null}

      {state.status === 'failed' ? (
        <div className="space-y-1 rounded-lg bg-[var(--status-error-background)] p-2" role="alert">
          <p className="typography-ui-label text-foreground">{t('chat.goal.writer.dialog.failed')}</p>
          <p className="typography-meta break-words text-muted-foreground">{state.reason}</p>
        </div>
      ) : null}

      {state.status === 'ready' ? (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate typography-meta text-muted-foreground" title={state.model}>
              {t('chat.goal.writer.dialog.writtenBy', { model: state.model })}
            </span>
            <span className="flex-shrink-0 typography-micro tabular-nums text-muted-foreground/70" aria-label={t('chat.goal.counter.aria')}>
              {spec.length}/{SESSION_GOAL_OBJECTIVE_CHAR_LIMIT}
            </span>
          </div>
          <Textarea
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
            maxLength={SESSION_GOAL_OBJECTIVE_CHAR_LIMIT}
            rows={mobile ? 10 : 14}
            aria-label={t('chat.goal.writer.dialog.specAria')}
          />
          <p className="typography-meta text-muted-foreground">{t('chat.goal.writer.dialog.reviewHint')}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={() => onSubmit(skip)}>
          {skipLabel}
        </Button>
        {state.status !== 'writing' ? (
          <Button variant="ghost" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            <Icon name="restart" className="size-3.5" aria-hidden="true" />
            {state.status === 'failed' ? t('chat.goal.writer.action.retry') : t('chat.goal.writer.action.rewrite')}
          </Button>
        ) : null}
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          {state.status === 'ready' ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={!trimmedSpec}
                onClick={() => onSubmit({ kind: 'spec', spec: trimmedSpec, sendMode: secondaryMode })}
              >
                {t(SEND_LABEL_KEYS[secondaryMode])}
              </Button>
              <Button
                size="sm"
                disabled={!trimmedSpec}
                onClick={() => onSubmit({ kind: 'spec', spec: trimmedSpec, sendMode: request.defaultSendMode })}
              >
                {t(SEND_LABEL_KEYS[request.defaultSendMode])}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={onCancel}>
              {t('chat.goal.action.cancel')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  if (mobile) {
    return (
      <MobileOverlayPanel open title={title} onClose={onCancel}>
        <div className="px-3 pb-4 pt-1">{content}</div>
      </MobileOverlayPanel>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      {content}
    </>
  );
}
