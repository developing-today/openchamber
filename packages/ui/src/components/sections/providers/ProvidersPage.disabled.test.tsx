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
 * providers is `disabled`. The catalog is what OpenCode lists. `server`
 * answers any other request first; `activeDirectory` is the directory the
 * app works in, whose catalog the composer's picker reads.
 */
const openProviderPage = async (providerId: string, { disabled, catalog, server, activeDirectory }: {
  disabled: string[];
  catalog: Array<Provider & { models: Model[] }>;
  server?: (request: Request) => Promise<Response | null>;
  activeDirectory?: string;
}) => {
  spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const answer = await server?.(request);
    if (answer) return answer;
    const { pathname } = new URL(request.url);
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
  const appDirectory = useConfigStore.getState().activeDirectoryKey;
  useConfigStore.setState({ providers: catalog, disabledProviderIds: null, activeDirectoryKey: activeDirectory ?? appDirectory });
  useUIStore.setState({ hiddenModels: [], settingsProvidersOpenRequested: providerId });
  const root = createRoot(dom.container);
  mounted = {
    root,
    restore: () => {
      configureRuntimeUrlResolver({ apiBaseUrl: '' });
      useConfigStore.setState({ providers: [], disabledProviderIds: null, activeDirectoryKey: appDirectory });
      dom.restore();
    },
  };

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
  const click = (label: string) => act(async () => {
    const button = Array.from(dom.container.querySelectorAll('button')).find((element) => element.textContent?.trim() === label);
    if (!button) throw new Error(`No button "${label}" in: ${dom.container.textContent}`);
    button.click();
  });
  /** The providers the composer's model picker offers: the store's catalog of the app's directory. */
  const offered = () => useConfigStore.getState().providers.map((provider) => provider.id);
  return { text: () => dom.container.textContent ?? '', hideButtons, hiddenModels: () => useUIStore.getState().hiddenModels, click, offered };
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
    expect(page.text()).toContain('model choices can still be changed');
    expect(page.text()).toContain('Fast Llama');
    expect(page.text()).toContain('deep');
    expect(page.text()).not.toContain('Accounts');
    expect(page.hideButtons()).toHaveLength(2);
    await act(async () => page.hideButtons()[0]?.click());
    expect(page.hiddenModels()).toEqual([{ providerID: 'lab', modelID: 'fast' }]);
  });

  // A built-in provider's config entry names no models, so the page lists
  // none of them: the notice says what brings them back, and never that
  // model choices can still be changed.
  test('a turned-off built-in provider with no models in its config says how to see them again', async () => {
    const page = await openProviderPage('groq', { disabled: ['groq'], catalog: [] });

    expect(page.text()).toContain('Turned off.');
    expect(page.text()).toContain('Turn it back on to see and choose its models.');
    expect(page.text()).not.toContain('model choices can still be changed');
    expect(page.hideButtons()).toHaveLength(0);
  });

  // OpenCode keeps listing a provider written into `disabled_providers` until
  // its location reloads, and a turn on one of its models then fails. Disable
  // takes it out of every catalog the store holds at once, a catalog read in
  // between leaves it out too, and the location of the directory the app
  // works in reloads, after which OpenCode drops it itself.
  test('Disable takes a provider out of every picker at once and has OpenCode reload the location', async () => {
    let reloaded = false;
    let finishReload: () => void = () => undefined;
    const reloads: string[] = [];
    const puts: string[] = [];
    const server = async (request: Request): Promise<Response | null> => {
      const { pathname } = new URL(request.url);
      if (pathname === '/api/provider/groq/disabled' && request.method === 'PUT') {
        puts.push(await request.text());
        return Response.json({ providers: ['groq'] });
      }
      if (pathname === '/api/location/reload' && request.method === 'POST') {
        reloads.push(decodeURIComponent(request.headers.get('x-opencode-directory') ?? ''));
        await new Promise<void>((resolve) => { finishReload = resolve; });
        reloaded = true;
        return new Response(null, { status: 204 });
      }
      if (pathname === '/api/provider') {
        return Response.json({ location: {}, data: reloaded ? [] : [{ id: 'groq', name: 'Groq', activation: 'auto', package: groq.package }] });
      }
      if (pathname === '/api/model') {
        return Response.json({ location: {}, data: reloaded ? [] : [llamaFast] });
      }
      return null;
    };
    const page = await openProviderPage('groq', { disabled: [], catalog: [groq], server, activeDirectory: '/repo' });
    const { useConfigStore } = await import('@/stores/useConfigStore');
    expect(page.offered()).toEqual(['groq']);

    await page.click('Disable');
    for (let turn = 0; turn < 3; turn += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    expect(puts).toEqual([JSON.stringify({ disabled: true })]);
    expect(page.offered()).toEqual([]);
    expect(page.text()).toContain('Turned off.');
    expect(reloads).toEqual(['/repo']);

    // OpenCode still lists it until the reload answers.
    await act(async () => { await useConfigStore.getState().loadProviders({ directory: '/repo', fresh: true }); });
    expect(page.offered()).toEqual([]);

    await act(async () => {
      finishReload();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(page.offered()).toEqual([]);
  });
});
