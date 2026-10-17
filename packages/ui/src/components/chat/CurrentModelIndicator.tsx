import React from 'react';

import type { Message, Part } from '@/lib/opencode/model';
import { formatModelRef } from '@/lib/opencode/modelRef';
import { useConfigStore } from '@/stores/useConfigStore';

const ROUTE_PROVIDER_ID = 'opencode-route';

interface CurrentModelIndicatorProps {
    messages: readonly { info: Message; parts: Part[] }[];
}

/**
 * Persistent `provider/model#variant` of the turn that is streaming, or the
 * last one otherwise — the real model, never only the pool name the picker
 * shows. When the current selection is a pool, both show: `pool · real`.
 */
const CurrentModelIndicator: React.FC<CurrentModelIndicatorProps> = ({ messages }) => {
    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);

    const lastAssistantModel = React.useMemo(() => {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const info = messages[index]?.info;
            if (info?.role === 'assistant' && info.providerID && info.modelID) {
                return { providerID: info.providerID, modelID: info.modelID, variant: info.variant };
            }
        }
        return undefined;
    }, [messages]);

    if (!lastAssistantModel) return null;

    const isPool = currentProviderId === ROUTE_PROVIDER_ID;

    return (
        <div
            className="flex min-w-0 items-center gap-1.5 px-1 font-mono text-xs text-muted-foreground/70"
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
