import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { create } from 'zustand';
import type { Message } from '@/lib/opencode/model';

type ConfigState = { currentProviderId: string; currentModelId: string };

const useConfigStore = create<ConfigState>(() => ({
    currentProviderId: 'anthropic',
    currentModelId: 'claude-sonnet-5.5',
}));

mock.module('@/stores/useConfigStore', () => ({ useConfigStore }));

let sessionMessages: Message[] = [];
mock.module('@/sync/sync-context', () => ({
    useSessionMessages: (sessionID: string) => (sessionID ? sessionMessages : []),
}));

const { default: CurrentModelIndicator } = await import('./CurrentModelIndicator');

const assistantMessage = (id: string, providerID: string, modelID: string, variant?: string): Message => ({
    id, sessionID: 's', role: 'assistant', time: { created: 1 }, agent: 'build', providerID, modelID, variant,
});

describe('CurrentModelIndicator', () => {
    let root: Root;
    let container: HTMLDivElement;
    let restore: () => void;

    beforeEach(() => {
        const win = new Window({ url: 'http://localhost' });
        const globals = {
            window: win, document: win.document, HTMLElement: win.HTMLElement,
            Element: win.Element, SVGElement: win.SVGElement, NodeList: win.NodeList,
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) {
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        }
        restore = () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        restore();
        sessionMessages = [];
        useConfigStore.setState({ currentProviderId: 'anthropic', currentModelId: 'claude-sonnet-5.5' });
    });

    test('shows the real model of the last assistant message', async () => {
        sessionMessages = [assistantMessage('a1', 'anthropic', 'claude-sonnet-5.5', 'high')];
        await act(async () => root.render(<CurrentModelIndicator sessionId="s1" />));
        const indicator = container.querySelector('[data-current-model-indicator]');
        expect(indicator?.textContent).toBe('anthropic/claude-sonnet-5.5#high');
    });

    test('shows the streaming/last message, not an earlier one', async () => {
        sessionMessages = [
            assistantMessage('a1', 'openai', 'gpt-6-luna'),
            assistantMessage('a2', 'anthropic', 'claude-sonnet-5.5'),
        ];
        await act(async () => root.render(<CurrentModelIndicator sessionId="s1" />));
        const indicator = container.querySelector('[data-current-model-indicator]');
        expect(indicator?.textContent).toBe('anthropic/claude-sonnet-5.5');
    });

    test('shows "pool · real model" when the selection is a pool', async () => {
        useConfigStore.setState({ currentProviderId: 'opencode-route', currentModelId: 'fast-strong' });
        sessionMessages = [assistantMessage('a1', 'github-copilot', 'gpt-6-luna', 'low')];
        await act(async () => root.render(<CurrentModelIndicator sessionId="s1" />));
        const indicator = container.querySelector('[data-current-model-indicator]');
        expect(indicator?.textContent).toBe('fast-strong·github-copilot/gpt-6-luna#low');
    });

    test('renders nothing before any assistant message exists', async () => {
        sessionMessages = [];
        await act(async () => root.render(<CurrentModelIndicator sessionId="s1" />));
        expect(container.querySelector('[data-current-model-indicator]')).toBeNull();
    });

    test('renders nothing without a session id', async () => {
        sessionMessages = [assistantMessage('a1', 'anthropic', 'claude-sonnet-5.5')];
        await act(async () => root.render(<CurrentModelIndicator sessionId={null} />));
        expect(container.querySelector('[data-current-model-indicator]')).toBeNull();
    });
});
