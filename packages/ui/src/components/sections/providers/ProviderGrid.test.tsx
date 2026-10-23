import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { IntegrationInfo } from '@opencode/client';

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'KeyboardEvent',
  'PointerEvent',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'ResizeObserver',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    Event: happyWindow.Event,
    KeyboardEvent: happyWindow.KeyboardEvent,
    PointerEvent: happyWindow.PointerEvent,
    localStorage: happyWindow.localStorage,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    ResizeObserver: happyWindow.ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const provider = (id: string, name: string) => ({
  id,
  name,
  activation: 'auto' as const,
  package: `@opencode/ai/providers/${id}`,
  models: [],
});

const integrations: IntegrationInfo[] = [
  { id: 'groq', name: 'Groq', methods: [], connections: [] },
];

let mounted: { root: Root; restore: () => void } | null = null;

const buttonsIn = (container: HTMLElement, label: string): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll('button')).filter((button) => button.textContent?.trim() === label);

describe('ProviderGrid disabled providers', () => {
  beforeEach(() => {
    spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({}), { status: 404, headers: { 'Content-Type': 'application/json' } }));
  });

  afterEach(async () => {
    mock.restore();
    if (!mounted) return;
    const current = mounted;
    mounted = null;
    await act(async () => current.root.unmount());
    current.restore();
  });

  test('a provider that is off shows Disabled beside its status and offers Enable on its card', async () => {
    const dom = installDom();
    const { createRoot } = await import('react-dom/client');
    const { ProviderGrid } = await import('./ProviderGrid');
    const { I18nProvider } = await import('@/lib/i18n');
    const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
    const root = createRoot(dom.container);
    mounted = { root, restore: dom.restore };
    const toggled: Array<[string, boolean]> = [];
    await act(async () => {
      root.render(
        <ThemeSystemProvider>
        <I18nProvider>
          <ProviderGrid
            providers={[provider('openai', 'OpenAI'), provider('groq', 'Groq')]}
            integrations={integrations}
            directory={null}
            onSelect={() => undefined}
            onConnect={() => undefined}
            onOpenClassification={() => undefined}
            disabledProviders={['groq']}
            onSetProviderDisabled={(providerId, disabled) => toggled.push([providerId, disabled])}
          />
        </I18nProvider>
        </ThemeSystemProvider>,
      );
    });

    expect(dom.container.textContent).toContain('Disabled');
    const enable = buttonsIn(dom.container, 'Enable');
    // One on the card, one in the list at the bottom.
    expect(enable.length).toBe(2);
    expect(buttonsIn(dom.container, 'Disable')).toHaveLength(1);

    await act(async () => enable[0]?.click());
    expect(toggled).toEqual([['groq', false]]);
  });

  test('a turned-off provider OpenCode no longer lists still gets a card, named by its integration', async () => {
    const dom = installDom();
    const { createRoot } = await import('react-dom/client');
    const { ProviderGrid } = await import('./ProviderGrid');
    const { I18nProvider } = await import('@/lib/i18n');
    const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
    const root = createRoot(dom.container);
    mounted = { root, restore: dom.restore };
    await act(async () => {
      root.render(
        <ThemeSystemProvider>
        <I18nProvider>
          <ProviderGrid
            providers={[provider('openai', 'OpenAI')]}
            integrations={integrations}
            directory={null}
            onSelect={() => undefined}
            onConnect={() => undefined}
            onOpenClassification={() => undefined}
            disabledProviders={['groq']}
            onSetProviderDisabled={() => undefined}
          />
        </I18nProvider>
        </ThemeSystemProvider>,
      );
    });

    const cardTitles = Array.from(dom.container.querySelectorAll('.text-sm.font-semibold')).map((node) => node.textContent);
    expect(cardTitles).toEqual(['Groq', 'OpenAI']);
  });

  test('the routes provider is named OpenCode Routes and has no status pill', async () => {
    const dom = installDom();
    const { createRoot } = await import('react-dom/client');
    const { ProviderGrid } = await import('./ProviderGrid');
    const { I18nProvider } = await import('@/lib/i18n');
    const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
    const root = createRoot(dom.container);
    mounted = { root, restore: dom.restore };
    await act(async () => {
      root.render(
        <ThemeSystemProvider>
        <I18nProvider>
          <ProviderGrid
            providers={[provider('opencode-route', 'opencode routes')]}
            integrations={integrations}
            directory={null}
            onSelect={() => undefined}
            onConnect={() => undefined}
            onOpenClassification={() => undefined}
          />
        </I18nProvider>
        </ThemeSystemProvider>,
      );
    });

    const cardTitles = Array.from(dom.container.querySelectorAll('.text-sm.font-semibold')).map((node) => node.textContent);
    expect(cardTitles).toContain('OpenCode Routes');
    expect(dom.container.textContent).not.toContain('Not signed in');
  });
});
