import React from 'react';

import { formatModelRef } from '@/lib/opencode/modelRef';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionMessages } from '@/sync/sync-context';

const ROUTE_PROVIDER_ID = 'opencode-route';

interface CurrentModelIndicatorProps {
    sessionId: string | null | undefined;
    directory?: string;
    className?: string;
}

/**
 * Persistent `provider/model#variant` of the turn that is streaming, or the
 * last one otherwise — the real model, never only the pool name the picker
 * shows. When the current selection is a pool, both show: `pool · real`.
 * Reads the session's own messages, so desktop and mobile composers mount
 * the same component without either threading messages through its parent.
 */
const CurrentModelIndicator: React.FC<CurrentModelIndicatorProps> = ({ sessionId, directory, className }) => {
    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const messages = useSessionMessages(sessionId ?? '', directory);

    const lastAssistantModel = React.useMemo(() => {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (!message || message.role !== 'assistant') continue;
            if (!message.providerID || !message.modelID) continue;
            return message;
        }
        return undefined;
    }, [messages]);

    if (!lastAssistantModel) return null;

    const isPool = currentProviderId === ROUTE_PROVIDER_ID;

    return (
        <div
            className={cn('flex min-w-0 items-center gap-1.5 px-1 font-mono text-xs text-muted-foreground/70', className)}
            data-current-model-indicator="true"
        >
            {isPool ? (
                <>
                    <span className="truncate">{currentModelId}</span>
                    <span aria-hidden="true" className="opacity-60">·</span>
                </>
            ) : null}
            <span className="truncate">{formatModelRef(lastAssistantModel)}</span>
        </div>
    );
};

export default React.memo(CurrentModelIndicator);
