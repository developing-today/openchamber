import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useMcpxSecretRequests } from '@/hooks/useMcpxSecretRequests';
import { useI18n } from '@/lib/i18n';
import { declineSecretRequest, putMcpxSecret, type McpxSecretRequest } from '@/lib/mcpxSecrets';

export type McpxSecretEntry = { name: string; value: string };

const blankEntries = (names: string[]): McpxSecretEntry[] => names.map((name) => ({ name, value: '' }));

type McpxSecretRequestDialogProps = {
  request: McpxSecretRequest;
  busy: boolean;
  error: string | null;
  onSubmit: (entries: McpxSecretEntry[]) => void;
  onDecline: () => void;
  onDismiss: () => void;
};

/**
 * One request's form. The typed values live in this component only until submit,
 * and submit clears them before the request goes out.
 */
export const McpxSecretRequestDialog = ({
  request,
  busy,
  error,
  onSubmit,
  onDecline,
  onDismiss,
}: McpxSecretRequestDialogProps) => {
  const { t } = useI18n();
  const fieldIdBase = React.useId();
  const [entries, setEntries] = React.useState<McpxSecretEntry[]>(() => blankEntries(request.secrets));
  const complete = entries.every((entry) => entry.value.trim() !== '');

  const setValue = (index: number, value: string) => {
    setEntries((current) => current.map((entry, position) => (position === index ? { ...entry, value } : entry)));
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !complete) return;
    const submitted = entries.map((entry) => ({ name: entry.name, value: entry.value.trim() }));
    setEntries(blankEntries(request.secrets));
    onSubmit(submitted);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <DialogContent layerClassName="z-[70]" backdropProps={{ className: 'z-[70]' }}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('mcpx.secrets.title', { server: request.server })}</DialogTitle>
            <DialogDescription>{t('mcpx.secrets.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {entries.map((entry, index) => {
              const fieldId = `${fieldIdBase}-${index}`;
              return (
                <div key={entry.name} className="space-y-1">
                  <label htmlFor={fieldId} className="font-mono typography-meta text-foreground">{entry.name}</label>
                  <Input
                    id={fieldId}
                    type="password"
                    autoComplete="off"
                    value={entry.value}
                    disabled={busy}
                    aria-label={t('mcpx.secrets.inputAria', { name: entry.name })}
                    onChange={(event) => setValue(index, event.currentTarget.value)}
                  />
                </div>
              );
            })}
          </div>
          {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onDecline}>
              {t('mcpx.secrets.decline')}
            </Button>
            <Button type="submit" disabled={busy || !complete}>
              {t('mcpx.secrets.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/**
 * App-level prompt for the secrets an mcpx server needs. It shows the oldest pending
 * request; the next one follows once this one is saved, declined or closed.
 */
export const McpxSecretRequestPrompt = () => {
  const { t } = useI18n();
  const { requests, refresh } = useMcpxSecretRequests();
  const [dismissedIds, setDismissedIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<{ requestId: string; message: string } | null>(null);
  const request = requests.find((candidate) => !dismissedIds.has(candidate.id)) ?? null;

  const dismiss = (requestId: string) => {
    setDismissedIds((current) => new Set(current).add(requestId));
  };

  const save = async (target: McpxSecretRequest, entries: McpxSecretEntry[]) => {
    setBusy(true);
    setFailure(null);
    for (const entry of entries) {
      try {
        await putMcpxSecret(entry.name, entry.value);
      } catch {
        setFailure({ requestId: target.id, message: t('mcpx.secrets.error.save', { name: entry.name }) });
        setBusy(false);
        return;
      }
    }
    // The daemon resolves the request once every secret is set. Wait for a list
    // read that starts after the writes, so this prompt does not linger.
    await refresh();
    setBusy(false);
  };

  const decline = async (target: McpxSecretRequest) => {
    setBusy(true);
    setFailure(null);
    try {
      await declineSecretRequest(target.id);
    } catch {
      setFailure({ requestId: target.id, message: t('mcpx.secrets.error.decline') });
      setBusy(false);
      return;
    }
    await refresh();
    setBusy(false);
  };

  if (!request) return null;
  return (
    <McpxSecretRequestDialog
      key={request.id}
      request={request}
      busy={busy}
      error={failure?.requestId === request.id ? failure.message : null}
      onSubmit={(entries) => { void save(request, entries); }}
      onDecline={() => { void decline(request); }}
      onDismiss={() => dismiss(request.id)}
    />
  );
};
