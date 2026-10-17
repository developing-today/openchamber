/**
 * Session-scoped, one-shot lookup of per-message model attribution (pool,
 * selection reason, failover), from `GET /api/model-routes/turns`. Fetched
 * once per session and refetched only when a turn finishes — never polled.
 */
import * as React from 'react';
import { fetchMessageModelAttribution, type MessageModelAttribution } from '@/lib/routing/modelRoutesApi';

export type MessageModelAttributionMap = Readonly<Record<string, MessageModelAttribution>>;

const EMPTY_MAP: MessageModelAttributionMap = {};

/**
 * `refetchKey` is anything that changes when a new turn finishes (e.g. the
 * count of completed assistant messages) — the moment OpenCode has written
 * that turn's attempt rows. Passing the same key across renders keeps the
 * previous result and fetches nothing.
 */
export const useMessageModelAttribution = (
    sessionID: string | undefined,
    refetchKey: number | string,
): MessageModelAttributionMap => {
    const [map, setMap] = React.useState<MessageModelAttributionMap>(EMPTY_MAP);

    React.useEffect(() => {
        if (!sessionID) {
            setMap(EMPTY_MAP);
            return;
        }
        let cancelled = false;
        fetchMessageModelAttribution(sessionID)
            .then((response) => {
                if (cancelled) return;
                setMap(response.available && response.messages ? response.messages : EMPTY_MAP);
            })
            .catch(() => {
                if (!cancelled) setMap(EMPTY_MAP);
            });
        return () => {
            cancelled = true;
        };
    }, [sessionID, refetchKey]);

    return map;
};
