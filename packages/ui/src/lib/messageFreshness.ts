import type { Message } from '@/lib/opencode/model';

// Upper bound on the seen-message set below. The detector is a page-lifetime
// singleton, so without a cap the set grows by one entry for every assistant
// message ever rendered. The cap is far above the visible/recent working set
// of any session, so an evicted (oldest-first) id can only be re-rendered
// long after its 5s freshness window has passed and cannot re-animate.
export const MAX_SEEN_MESSAGE_IDS = 2000;

export class MessageFreshnessDetector {
    private static instance: MessageFreshnessDetector;
    private sessionStartTimes: Map<string, number> = new Map();
    private seenMessageIds: Set<string> = new Set();

    private constructor() {}

    static getInstance(): MessageFreshnessDetector {
        if (!MessageFreshnessDetector.instance) {
            MessageFreshnessDetector.instance = new MessageFreshnessDetector();
        }
        return MessageFreshnessDetector.instance;
    }

    recordSessionStart(sessionId: string): void {
        this.sessionStartTimes.set(sessionId, Date.now());
    }

    getSessionStartTime(sessionId: string): number | undefined {
        return this.sessionStartTimes.get(sessionId);
    }

    private recordSeenMessage(messageId: string): void {
        this.seenMessageIds.add(messageId);
        while (this.seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
            const oldest = this.seenMessageIds.values().next().value;
            if (oldest === undefined) break;
            this.seenMessageIds.delete(oldest);
        }
    }

    shouldAnimateMessage(message: Message, sessionId: string): boolean {

        if (message.role !== 'assistant') {
            return false;
        }

        if (this.seenMessageIds.has(message.id)) {
            return false;
        }

        const sessionStartTime = this.sessionStartTimes.get(sessionId);

        if (!sessionStartTime) {

            this.recordSeenMessage(message.id);
            return false;
        }

        const isFresh = message.time.created > (sessionStartTime - 5000);

        // Record fresh messages too so they animate at most once per detector
        // lifetime. The detector is a module singleton that outlives ChatViewport
        // remounts; without this, switching away and back re-evaluates the same
        // message against the stale session start time (recordSessionStart runs
        // in an effect after the first render) and replays the entry animation.
        this.recordSeenMessage(message.id);

        return isFresh;
    }

    clearSession(sessionId: string): void {
        this.sessionStartTimes.delete(sessionId);

    }

     hasSessionTiming(sessionId: string): boolean {
         return this.sessionStartTimes.has(sessionId);
     }

     hasBeenAnimated(messageId: string): boolean {
        return this.seenMessageIds.has(messageId);
    }

    markMessageAsAnimated(messageId: string): void {
        this.recordSeenMessage(messageId);
    }

    clearAll(): void {
        this.sessionStartTimes.clear();
        this.seenMessageIds.clear();
    }

    getDebugInfo(): {
        sessionStartTimes: Map<string, number>;
        seenMessageIds: Set<string>;
    } {
        return {
            sessionStartTimes: new Map(this.sessionStartTimes),
            seenMessageIds: new Set(this.seenMessageIds)
        };
    }
}
