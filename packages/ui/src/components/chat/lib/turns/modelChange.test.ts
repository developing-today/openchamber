import { describe, expect, test } from 'bun:test';
import type { AssistantMessage } from '@/lib/opencode/model';
import { detectModelChange, turnRealModel, turnRealModelRef } from './modelChange';
import type { ChatMessageEntry, TurnRecord } from './types';

const assistant = (id: string, providerID: string, modelID: string, variant?: string): ChatMessageEntry => {
    const info: AssistantMessage = {
        id,
        sessionID: 's',
        role: 'assistant',
        time: { created: 1 },
        agent: 'build',
        providerID,
        modelID,
        variant,
    };
    return { info, parts: [] };
};

const turnOf = (assistantMessages: ChatMessageEntry[]): Pick<TurnRecord, 'assistantMessages'> => ({ assistantMessages });

describe('turnRealModel', () => {
    test('reads the last assistant message with a model', () => {
        const turn = turnOf([assistant('a1', 'openai', 'gpt-6'), assistant('a2', 'anthropic', 'claude-sonnet-5.5', 'high')]);
        expect(turnRealModel(turn)).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-5.5', variant: 'high' });
    });

    test('undefined for a turn with no assistant messages yet', () => {
        expect(turnRealModel(turnOf([]))).toBeUndefined();
    });
});

describe('turnRealModelRef', () => {
    test('formats the compact ref', () => {
        expect(turnRealModelRef(turnOf([assistant('a1', 'github-copilot', 'gpt-6-luna', 'low')]))).toBe(
            'github-copilot/gpt-6-luna#low',
        );
    });
});

describe('detectModelChange', () => {
    const previous = { providerID: 'openai', modelID: 'gpt-6-luna' };

    test('undefined when the real model matches the previous turn', () => {
        const turn = turnOf([assistant('a1', 'openai', 'gpt-6-luna')]);
        expect(detectModelChange(previous, turn)).toBeUndefined();
    });

    test('a notice when round-robin (or failover) picked a different target', () => {
        const turn = turnOf([assistant('a1', 'github-copilot', 'gpt-6-luna', 'low')]);
        expect(detectModelChange(previous, turn)).toEqual({
            from: previous,
            to: { providerID: 'github-copilot', modelID: 'gpt-6-luna', variant: 'low' },
        });
    });

    test('undefined without a previous turn (the first turn of a session)', () => {
        const turn = turnOf([assistant('a1', 'openai', 'gpt-6-luna')]);
        expect(detectModelChange(undefined, turn)).toBeUndefined();
    });

    test('undefined while the new turn has no assistant model yet (still streaming in)', () => {
        expect(detectModelChange(previous, turnOf([]))).toBeUndefined();
    });
});
