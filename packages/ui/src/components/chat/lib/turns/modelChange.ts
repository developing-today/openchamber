/**
 * The real model a turn ran on, and whether it changed from the turn before
 * it. "Real" means the model on the assistant message itself
 * (`providerID`/`modelID`/`variant`), never the pool the user has selected —
 * that is the whole point of the change marker: a pool can answer a
 * round-robin turn on a different real target than the one before it.
 */
import { formatModelRef, isSameModelRef, type ModelRefLike } from '@/lib/opencode/modelRef';
import type { TurnRecord } from './types';

type TurnWithAssistants = Pick<TurnRecord, 'assistantMessages'>;

/** The model on this turn's last assistant message that has one, or `undefined` for a turn with none yet. */
export const turnRealModel = (turn: TurnWithAssistants): ModelRefLike | undefined => {
    for (let index = turn.assistantMessages.length - 1; index >= 0; index -= 1) {
        const info = turn.assistantMessages[index]?.info;
        if (info?.role === 'assistant' && info.providerID && info.modelID) {
            return { providerID: info.providerID, modelID: info.modelID, variant: info.variant };
        }
    }
    return undefined;
};

/** Compact form of {@link turnRealModel}, for cheap storage/comparison on a timeline entry. */
export const turnRealModelRef = (turn: TurnWithAssistants): string | undefined => {
    const model = turnRealModel(turn);
    return model ? formatModelRef(model) : undefined;
};

/**
 * The most recent real model among `turns`, scanning from the end backward —
 * the "previous model" a turn that follows all of them should compare
 * against. `undefined` when none of them has one yet.
 *
 * This is what the transcript's trailing row (the last turn, idle or
 * streaming — see `MessageList`'s `trailingStreamingEntry`) needs for its own
 * model-changed check: it sits outside `buildHistoryEntries`, so it cannot
 * read the running accumulator `orderHistoryEntries` keeps for every turn
 * before it, and must ask every history turn again here instead.
 */
export const lastKnownModelRef = (turns: readonly TurnWithAssistants[]): string | undefined => {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
        const ref = turnRealModelRef(turns[index]);
        if (ref) return ref;
    }
    return undefined;
};

interface ModelChangeNotice {
    readonly from: ModelRefLike;
    readonly to: ModelRefLike;
}

/** The change marker for `turn`, or `undefined` when its model matches the previous turn's (or either is unknown). */
export const detectModelChange = (
    previous: ModelRefLike | undefined,
    turn: TurnWithAssistants,
): ModelChangeNotice | undefined => {
    const current = turnRealModel(turn);
    if (!previous || !current || isSameModelRef(previous, current)) return undefined;
    return { from: previous, to: current };
};
