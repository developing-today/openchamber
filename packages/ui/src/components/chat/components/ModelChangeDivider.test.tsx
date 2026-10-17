import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { ModelAttributionProvider } from '../context/ModelAttributionContext';
import ModelChangeDivider from './ModelChangeDivider';

describe('ModelChangeDivider', () => {
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
    });

    test('names both models without a reason when none is known', async () => {
        await act(async () => root.render(
            <I18nProvider>
                <ModelAttributionProvider value={{}}>
                    <ModelChangeDivider from="openai/gpt-6-luna" to="github-copilot/gpt-6-luna#low" />
                </ModelAttributionProvider>
            </I18nProvider>,
        ));
        const divider = container.querySelector('[data-model-changed-divider]');
        expect(divider?.textContent).toContain('openai/gpt-6-luna');
        expect(divider?.textContent).toContain('github-copilot/gpt-6-luna#low');
        expect(divider?.textContent).not.toContain('(');
    });

    test('adds the failover reason when the attribution lookup has one', async () => {
        await act(async () => root.render(
            <I18nProvider>
                <ModelAttributionProvider value={{
                    msg_1: {
                        providerID: 'github-copilot', modelID: 'gpt-6-luna', variant: 'low', routeID: 'fast-strong',
                        selection: { mode: 'ordered', reason: 'ordered' },
                        failover: {
                            providerID: 'openai', modelID: 'gpt-6-luna', variant: null,
                            errorTag: 'Timeout', errorMessage: 'first-token timeout',
                        },
                    },
                }}>
                    <ModelChangeDivider from="openai/gpt-6-luna" to="github-copilot/gpt-6-luna#low" assistantMessageId="msg_1" />
                </ModelAttributionProvider>
            </I18nProvider>,
        ));
        const divider = container.querySelector('[data-model-changed-divider]');
        expect(divider?.textContent).toContain('first-token timeout');
    });

    test('falls back to the selection reason when there was no failover', async () => {
        await act(async () => root.render(
            <I18nProvider>
                <ModelAttributionProvider value={{
                    msg_1: {
                        providerID: 'github-copilot', modelID: 'gpt-6-luna', variant: 'low', routeID: 'fast-strong',
                        selection: { mode: 'round-robin', reason: 'drawn' },
                        failover: null,
                    },
                }}>
                    <ModelChangeDivider from="openai/gpt-6-luna" to="github-copilot/gpt-6-luna#low" assistantMessageId="msg_1" />
                </ModelAttributionProvider>
            </I18nProvider>,
        ));
        const divider = container.querySelector('[data-model-changed-divider]');
        expect(divider?.textContent).toContain('drawn');
    });
});
