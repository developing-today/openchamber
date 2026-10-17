import React from 'react';

import type { ChatMessageEntry, Turn } from '../lib/turns/types';
import ModelChangeDivider from './ModelChangeDivider';
import TurnAssistantBlock from './TurnAssistantBlock';

interface TurnItemProps {
    turn: Turn;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
    assistantContent?: React.ReactNode;
    /** Set when this turn's real model differs from the one before it (round-robin, failover, or a manual switch). */
    modelChange?: { from: string; to: string };
}

const TurnItem: React.FC<TurnItemProps> = ({ turn, renderMessage, assistantContent, modelChange }) => {
    return (
        <section
            className="relative w-full"
            id={`turn-${turn.turnId}`}
            data-turn-id={turn.turnId}
            data-scroll-spy-id={turn.turnId}
        >
            {modelChange ? (
                <ModelChangeDivider
                    from={modelChange.from}
                    to={modelChange.to}
                    assistantMessageId={turn.assistantMessages[0]?.info.id}
                />
            ) : null}
            {renderMessage(turn.userMessage)}

            {assistantContent ?? <TurnAssistantBlock turnId={turn.turnId} assistantMessages={turn.assistantMessages} renderMessage={renderMessage} />}
        </section>
    );
};

export default React.memo(TurnItem);
