import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import type { GoalSpecResult, GoalSubmitChoice, GoalWriterChoice, GoalWriterTrigger } from '@/lib/goalWriter';
import { GoalWriterPicker } from '@/components/chat/GoalWriterPicker';
import { useGoalWriterDefault } from '@/hooks/useGoalWriterDefault';
import { recordGoalWriterChoice } from '@/lib/modelChoices';
import { useI18n } from '@/lib/i18n';
import { useUIStore, type SessionGoalWriterSendMode } from '@/stores/useUIStore';

export interface GoalSpecDialogRequest {
  /** A new id starts a new writing run. */
  id: number;
  trigger: GoalWriterTrigger;
  /** False sends the spec as soon as it is written; the dialog only shows progress or a failure. */
  review: boolean;
  defaultSendMode: SessionGoalWriterSendMode;
  /** The model the message is sent with; it writes when Settings name no writer model. */
  sessionModel: { providerID: string; modelID: string } | null;
  directory: string | null;
  /** Length of the message the goal is written from; only its size bucket is recorded. */
  inputLength: number;
  /** `writer` is a model picked in the dialog; null keeps the default. */
  write: (signal: AbortSignal, options: { writer: GoalWriterChoice | null; ignoreLimit: boolean }) => Promise<GoalSpecResult>;
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
      {/* Resizes from its corner, like the goal editor; see SessionGoalDialog. */}
      <DialogContent className="w-[36rem] max-w-[calc(100vw-2rem)] min-w-[20rem] min-h-[16rem] resize transition-[opacity,transform,filter]">{body}</DialogContent>
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
  const [writer, setWriter] = React.useState<GoalWriterChoice | null>(null);
  const [ignoreLimit, setIgnoreLimit] = React.useState(false);
  const charLimit = useUIStore((state) => state.sessionGoalObjectiveCharLimit);
  const onSubmitRef = React.useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  // A writing run reads the picks made when it starts; changing them asks for
  // another run ("Write again"), never a silent restart.
  const writeOptionsRef = React.useRef({ writer, ignoreLimit });
  writeOptionsRef.current = { writer, ignoreLimit };
  const writerDefault = useGoalWriterDefault();
  const writerDefaultRef = React.useRef(writerDefault);
  writerDefaultRef.current = writerDefault;
  // "Write again" with the same pick is one choice, recorded once.
  const recordedWriterRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'writing' });
    const run = async () => {
      const { writer: picked } = writeOptionsRef.current;
      const pickedKey = picked ? `${picked.providerID}/${picked.modelID}:${picked.variant ?? ''}` : null;
      if (picked && pickedKey !== recordedWriterRef.current) {
        recordedWriterRef.current = pickedKey;
        recordGoalWriterChoice({
          writer: picked,
          writerDefault: writerDefaultRef.current,
          sessionModel: request.sessionModel,
          inputLength: request.inputLength,
        });
      }
      let result: GoalSpecResult;
      try {
        result = await request.write(controller.signal, writeOptionsRef.current);
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setState({ status: 'failed', reason: result.message });
        return;
      }
      if (!request.review) {
        onSubmitRef.current({ kind: 'spec', spec: result.spec, sendMode: request.defaultSendMode, ignoreLimit: writeOptionsRef.current.ignoreLimit });
        return;
      }
      setSpec(result.spec);
      setState({ status: 'ready', model: `${result.providerID}/${result.modelID}${result.variant ? ` · ${result.variant}` : ''}` });
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
    <div className="flex min-h-0 flex-1 flex-col gap-3">
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

      <div className="flex items-start justify-between gap-2">
        <GoalWriterPicker
          directory={request.directory}
          sessionModel={request.sessionModel}
          value={writer}
          onChange={setWriter}
          disabled={state.status === 'writing'}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-7 w-7 shrink-0 px-0" aria-label={t('chat.goal.dialog.moreAria')}>
              <Icon name="more-2" className="size-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setIgnoreLimit((value) => !value)} className="flex items-center justify-between gap-4">
              <span>{t('chat.goal.dialog.ignoreLimit')}</span>
              {ignoreLimit ? <Icon name="check" className="size-4 text-primary" aria-hidden="true" /> : null}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {state.status === 'ready' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate typography-meta text-muted-foreground" title={state.model}>
              {t('chat.goal.writer.dialog.writtenBy', { model: state.model })}
            </span>
            <span
              className={!ignoreLimit && spec.length > charLimit ? 'flex-shrink-0 typography-micro tabular-nums text-status-warning' : 'flex-shrink-0 typography-micro tabular-nums text-muted-foreground/70'}
              aria-label={t('chat.goal.counter.aria')}
            >
              {ignoreLimit ? spec.length : `${spec.length}/${charLimit}`}
            </span>
          </div>
          <Textarea
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
            rows={mobile ? 10 : 14}
            fillContainer={!mobile}
            outerClassName={mobile ? undefined : 'min-h-0 flex-1'}
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
                onClick={() => onSubmit({ kind: 'spec', spec: trimmedSpec, sendMode: secondaryMode, ignoreLimit })}
              >
                {t(SEND_LABEL_KEYS[secondaryMode])}
              </Button>
              <Button
                size="sm"
                disabled={!trimmedSpec}
                onClick={() => onSubmit({ kind: 'spec', spec: trimmedSpec, sendMode: request.defaultSendMode, ignoreLimit })}
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
