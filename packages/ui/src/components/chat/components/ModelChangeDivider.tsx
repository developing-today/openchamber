import React from 'react';

import { useI18n } from '@/lib/i18n';
import { useModelAttributionFor } from '../context/useModelAttributionFor';

interface ModelChangeDividerProps {
    /** The previous turn's real model, already compact (`provider/model#variant`). */
    from: string;
    /** This turn's real model, already compact. */
    to: string;
    /** This turn's first assistant message, to look up why it changed (round-robin, sticky, failover). */
    assistantMessageId?: string;
}

/**
 * Marks a turn whose real model differs from the one before it — a pool's
 * round-robin pick, a failover, or the user switching model/variant. The
 * reason shows only when the session-scoped routing lookup knows one; a
 * change with no known reason still gets the marker, just without it.
 */
const ModelChangeDivider: React.FC<ModelChangeDividerProps> = ({ from, to, assistantMessageId }) => {
    const { t } = useI18n();
    const attribution = useModelAttributionFor(assistantMessageId);
    const reason = attribution?.failover
        ? (attribution.failover.errorMessage || attribution.failover.errorTag || undefined)
        : (attribution?.selection?.reason ?? undefined);
    const text = reason
        ? t('chat.messageBody.modelChanged.noticeWithReason', { from, to, reason })
        : t('chat.messageBody.modelChanged.notice', { from, to });

    return (
        <div
            className="my-2 flex items-center gap-2 px-1 text-xs text-muted-foreground/70"
            data-model-changed-divider="true"
        >
            <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
            <span className="whitespace-nowrap font-mono">{text}</span>
            <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
        </div>
    );
};

export default React.memo(ModelChangeDivider);
