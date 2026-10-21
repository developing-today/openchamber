import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SessionGoalDialog } from '@/components/chat/SessionGoalDialog';
import { cancelGoalEdit } from '@/lib/goalEdit';
import { useI18n } from '@/lib/i18n';
import { useGoalEditStore, type GoalEditJob } from '@/stores/useGoalEditStore';

interface GoalEditStripProps {
  sessionId: string | null;
  directory?: string;
}

const useElapsedSeconds = (running: boolean): number => {
  const [seconds, setSeconds] = React.useState(0);
  React.useEffect(() => {
    setSeconds(0);
    if (!running) return undefined;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return seconds;
};

/**
 * A goal edit saved from the goal editor, among the composer's top rows: the
 * editor closes at once, and this row says the goal writer is working (with
 * Cancel), or why the edit did not land (with Reopen, which brings the edit
 * back into the editor).
 */
export const GoalEditStrip: React.FC<GoalEditStripProps> = React.memo(({ sessionId, directory }) => {
  const job = useGoalEditStore((state) => (sessionId ? state.jobs[sessionId] : undefined));
  if (!sessionId || !job) return null;
  return <GoalEditStripRow key={job.jobId} sessionId={sessionId} directory={directory} job={job} />;
});

GoalEditStrip.displayName = 'GoalEditStrip';

function GoalEditStripRow({ sessionId, directory, job }: { sessionId: string; directory?: string; job: GoalEditJob }) {
  const { t } = useI18n();
  const [editorOpen, setEditorOpen] = React.useState(false);
  const seconds = useElapsedSeconds(job.status === 'saving');

  const text = (() => {
    if (job.status === 'saving') {
      if (!job.rewriting) return t('chat.goal.edit.card.saving');
      return job.writerLabel
        ? t('chat.goal.edit.card.rewritingWith', { model: job.writerLabel, seconds })
        : t('chat.goal.edit.card.rewriting', { seconds });
    }
    if (job.status === 'changed') return t('chat.goal.edit.card.changed');
    return job.stage === 'message'
      ? t('chat.goal.edit.card.messageFailed', { reason: job.reason })
      : t('chat.goal.edit.card.failed', { reason: job.reason });
  })();

  const dismiss = () => useGoalEditStore.getState().finishJob(sessionId, job.jobId, null);

  return (
    <div role="status" className="border-b border-border/60">
      <div className="flex h-10 min-w-0 items-center gap-2 ps-3 pe-1.5">
        <Icon
          name={job.status === 'saving' ? 'loader-4' : 'error-warning'}
          className={job.status === 'saving' ? 'size-3.5 shrink-0 animate-spin text-muted-foreground' : 'size-3.5 shrink-0 text-status-warning'}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground" title={text}>{text}</span>
        {job.status === 'saving' ? (
          <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => cancelGoalEdit(sessionId)}>
            {t('chat.goal.action.cancel')}
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setEditorOpen(true)}>
              {t('chat.goal.edit.card.reopen')}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={dismiss}>
              {t('chat.goal.edit.card.dismiss')}
            </Button>
          </>
        )}
      </div>
      {editorOpen ? (
        <SessionGoalDialog open onOpenChange={setEditorOpen} sessionId={sessionId} directory={directory} initialDraft={job.status === 'saving' ? undefined : job.draft} />
      ) : null}
    </div>
  );
}
