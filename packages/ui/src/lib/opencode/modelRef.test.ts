import { describe, expect, test } from 'bun:test';
import { formatModelRef, isSameModelRef } from './modelRef';

describe('formatModelRef', () => {
    test('joins provider and model', () => {
        expect(formatModelRef({ providerID: 'github-copilot', modelID: 'gpt-6-luna' })).toBe('github-copilot/gpt-6-luna');
    });

    test('appends a non-default variant', () => {
        expect(formatModelRef({ providerID: 'github-copilot', modelID: 'gpt-6-luna', variant: 'low' })).toBe(
            'github-copilot/gpt-6-luna#low',
        );
    });

    test('omits an explicit "default" variant', () => {
        expect(formatModelRef({ providerID: 'anthropic', modelID: 'claude-sonnet-5.5', variant: 'default' })).toBe(
            'anthropic/claude-sonnet-5.5',
        );
    });
});

describe('isSameModelRef', () => {
    const a = { providerID: 'openai', modelID: 'gpt-6', variant: 'high' };

    test('true for the same provider, model and variant', () => {
        expect(isSameModelRef(a, { ...a })).toBe(true);
    });

    test('false when the variant differs', () => {
        expect(isSameModelRef(a, { ...a, variant: 'low' })).toBe(false);
    });

    test('treats a missing variant and "default"-less as equal', () => {
        const noVariant = { providerID: 'openai', modelID: 'gpt-6' };
        expect(isSameModelRef(noVariant, { ...noVariant })).toBe(true);
    });

    test('false when the model differs', () => {
        expect(isSameModelRef(a, { ...a, modelID: 'gpt-6-luna' })).toBe(false);
    });

    test('undefined only equals undefined', () => {
        expect(isSameModelRef(undefined, undefined)).toBe(true);
        expect(isSameModelRef(a, undefined)).toBe(false);
        expect(isSameModelRef(undefined, a)).toBe(false);
    });
});
