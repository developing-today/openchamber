import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { Model, Provider } from '@/lib/opencode/model';

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
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
    HTMLInputElement: happyWindow.HTMLInputElement,
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

const noSources = {
  auth: { exists: false },
  user: { exists: false, path: null },
  project: { exists: false, path: null },
  custom: { exists: false, path: null },
};

/** `lab` as the user's OpenCode config defines it: two models, one named. */
const labSource = {
  providerId: 'lab',
  sources: { ...noSources, user: { exists: true, path: '/home/me/.config/opencode/opencode.json' } },
  config: {
    name: 'Lab Gateway',
    package: 'aisdk:@ai-sdk/openai-compatible',
    settings: { baseURL: 'http://127.0.0.1:11434/v1' },
    models: { fast: { modelID: 'llama3:8b', name: 'Fast Llama' }, deep: {} },
  },
};

const llamaFast: Model = {
  id: 'llama-fast',
  modelID: 'llama-fast',
  providerID: 'groq',
  name: 'Llama Fast',
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [],
  time: { released: 1 },
  cost: [],
  status: 'active',
  enabled: true,
  limit: { context: 128_000, output: 8_000 },
};

const groq: Provider & { models: Model[] } = {
  id: 'groq',
  name: 'Groq',
  activation: 'auto',
  package: '@opencode/ai/providers/groq',
  models: [llamaFast],
};

let mounted: { root: Root; restore: () => void } | null = null;

/**
 * Opens the page on one provider over a server whose list of turned-off
 * providers is `disabled`. The catalog is what OpenCode lists.
 */
const openProviderPage = async (providerId: string, { disabled, catalog }: { disabled: string[]; catalog: Array<Provider & { models: Model[] }> }) => {
  spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    if (pathname === '/api/provider/disabled') return Response.json({ providers: disabled });
    if (pathname === '/api/provider/lab/source') return Response.json(labSource);
    if (pathname === '/api/provider/groq/source') return Response.json({ providerId: 'groq', sources: noSources, config: null });
    return Response.json({}, { status: 404 });
  });
  const dom = installDom();
  const { createRoot } = await import('react-dom/client');
  const { ProvidersPage } = await import('./ProvidersPage');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { configureRuntimeUrlResolver } = await import('@/lib/runtime-url');
  const { useConfigStore } = await import('@/stores/useConfigStore');
  const { useUIStore } = await import('@/stores/useUIStore');
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://providers-page.test' });
  useConfigStore.setState({ providers: catalog });
  useUIStore.setState({ hiddenModels: [], settingsProvidersOpenRequested: providerId });
  const root = createRoot(dom.container);
  mounted = { root, restore: () => { configureRuntimeUrlResolver({ apiBaseUrl: '' }); dom.restore(); } };

  await act(async () => {
    root.render(
      <ThemeSystemProvider>
        <I18nProvider>
          <ProvidersPage />
        </I18nProvider>
      </ThemeSystemProvider>,
    );
  });
  // The list of turned-off providers and the provider's config entry arrive.
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  const hideButtons = () => Array.from(dom.container.querySelectorAll('button')).filter((button) => button.getAttribute('aria-label') === 'Hide model');
  return { text: () => dom.container.textContent ?? '', hideButtons, hiddenModels: () => useUIStore.getState().hiddenModels };
};

describe('ProvidersPage models', () => {
  afterEach(async () => {
    mock.restore();
    if (!mounted) return;
    const current = mounted;
    mounted = null;
    await act(async () => current.root.unmount());
    current.restore();
  });

  test('a provider OpenCode lists shows its catalog models with their show and hide switches', async () => {
    const page = await openProviderPage('groq', { disabled: [], catalog: [groq] });

    expect(page.text()).toContain('Accounts');
    expect(page.text()).toContain('Llama Fast');
    await act(async () => page.hideButtons()[0]?.click());
    expect(page.hiddenModels()).toEqual([{ providerID: 'groq', modelID: 'llama-fast' }]);
  });

  // Measured on OpenCode 2.0.30, a provider in `disabled_providers` is gone
  // from both `GET /api/provider` and `GET /api/model`, so the catalog holds
  // nothing of it and its OpenCode config entry is what names its models.
  test('a turned-off provider OpenCode no longer lists keeps the switches of the models its config names, and shows no accounts', async () => {
    const page = await openProviderPage('lab', { disabled: ['lab'], catalog: [] });

    expect(page.text()).toContain('Turned off.');
    expect(page.text()).toContain('Fast Llama');
    expect(page.text()).toContain('deep');
    expect(page.text()).not.toContain('Accounts');
    expect(page.hideButtons()).toHaveLength(2);
    await act(async () => page.hideButtons()[0]?.click());
    expect(page.hiddenModels()).toEqual([{ providerID: 'lab', modelID: 'fast' }]);
  });
});
