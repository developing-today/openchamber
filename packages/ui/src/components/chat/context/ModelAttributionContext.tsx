/**
 * Exposes the session's per-message model attribution (see
 * `useMessageModelAttribution`) to the message footer and the model-changed
 * divider without threading it through every row prop in `MessageList`.
 */
import React from 'react';
import { ModelAttributionContext } from './modelAttributionContextValue';
import type { MessageModelAttributionMap } from '../hooks/useMessageModelAttribution';

export const ModelAttributionProvider: React.FC<{
    value: MessageModelAttributionMap;
    children: React.ReactNode;
}> = ({ value, children }) => (
    <ModelAttributionContext.Provider value={value}>{children}</ModelAttributionContext.Provider>
);
