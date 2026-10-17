import * as React from 'react';
import type { MessageModelAttribution } from '@/lib/routing/modelRoutesApi';
import { ModelAttributionContext } from './modelAttributionContextValue';

/** The attribution for one assistant message, or `undefined` when none is known (not routed, or not fetched yet). */
export const useModelAttributionFor = (messageId: string | undefined): MessageModelAttribution | undefined => {
    const map = React.useContext(ModelAttributionContext);
    return messageId ? map[messageId] : undefined;
};
