import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { KNOWLEDGE_ICON_BUTTON_CLASS } from '@/components/session/project-context/knowledgeRowStyle';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import type { MessagingWriteOutcome } from '@/stores/useMessagingStore';
import { useUIStore } from '@/stores/useUIStore';
import { MessagingStatusLine } from './MessagingStatusLine';

/** OpenCode stores messages of any size; this keeps a pasted log from freezing the field. */
const MAX_LENGTH = 50_000;

type ComposerState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  /** A soft write limit refused the text; sending it again with force writes it anyway. */
  | { kind: 'refused'; text: string; policy: string }
  | { kind: 'failed'; error: string };

/**
 * The field that writes a message: Enter sends, Shift+Enter starts a new line
 * (on a phone Return starts a line and the button sends), like the chat
 * composer. The text clears once OpenCode stored the message. When a topic's
 * write limit refuses it, the line under the field says why and offers to
 * send it anyway; limits are soft, so that always works.
 */
export const MessagingComposer: React.FC<{
  placeholder: string;
  onSend: (text: string, force: boolean) => Promise<MessagingWriteOutcome>;
  /** Controls before the send button, such as a delivery choice. */
  extraActions?: React.ReactNode;
  autoFocus?: boolean;
}> = ({ placeholder, onSend, extraActions, autoFocus = false }) => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const [text, setText] = React.useState('');
  const [state, setState] = React.useState<ComposerState>({ kind: 'idle' });

  const send = async (value: string, force: boolean) => {
    const trimmed = value.trim();
    if (!trimmed || state.kind === 'sending') return;
    setState({ kind: 'sending' });
    const outcome = await onSend(trimmed, force);
    if (outcome.kind === 'sent') {
      // Clear only what was sent; text typed meanwhile stays.
      setText((current) => (current.trim() === trimmed ? '' : current));
      setState({ kind: 'idle' });
      return;
    }
    setState(outcome.kind === 'refused' ? { kind: 'refused', text: trimmed, policy: outcome.policy } : { kind: 'failed', error: outcome.error });
  };

  return (
    <div>
      <div className="oc-surface-elevated oc-raised oc-field flex items-end gap-1 rounded-lg bg-[var(--surface-elevated)] py-1 pe-1 ps-3">
        <textarea
          rows={1}
          value={text}
          autoFocus={autoFocus}
          onChange={(event) => {
            setText(event.target.value.slice(0, MAX_LENGTH));
            if (state.kind === 'refused' || state.kind === 'failed') setState({ kind: 'idle' });
          }}
          onKeyDown={(event) => {
            if (isIMECompositionEvent(event) || event.key !== 'Enter') return;
            const modified = event.ctrlKey || event.metaKey;
            if (modified || (!isMobile && !event.shiftKey)) {
              event.preventDefault();
              void send(text, false);
            }
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck
          autoComplete="off"
          className={cn(
            'block max-h-[calc(10lh+0.25rem)] min-h-6 w-full min-w-0 resize-none field-sizing-content bg-transparent py-0.5 typography-markdown md:typography-ui-label text-foreground outline-none placeholder:text-muted-foreground',
            'focus-visible:outline-none',
          )}
        />
        {extraActions}
        <button
          type="button"
          onClick={() => void send(text, false)}
          disabled={state.kind === 'sending' || text.trim().length === 0}
          className={KNOWLEDGE_ICON_BUTTON_CLASS}
          aria-label={t('messaging.thread.send')}
          title={t('messaging.thread.send')}
        >
          <Icon name="send-plane-2" className="h-4 w-4" />
        </button>
      </div>
      <MessagingStatusLine
        text={
          state.kind === 'refused'
            ? t('messaging.thread.refused', { policy: state.policy })
            : state.kind === 'failed'
              ? t('messaging.thread.sendFailed', { error: state.error })
              : null
        }
        tone="error"
        action={state.kind === 'refused' ? (
          <Button type="button" variant="outline" size="xs" onClick={() => void send(state.text, true)}>
            {t('messaging.thread.sendAnyway')}
          </Button>
        ) : null}
      />
    </div>
  );
};
