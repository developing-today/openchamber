import { afterAll, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { MessagingConfig } from '@/lib/messagingConfigApi';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, DocumentFragment: browser.DocumentFragment,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

// Bun does not expand Vite's asset glob. Keep the production module and supply its actual SVG URLs.
plugin({
  name: 'messaging-settings-provider-logos',
  setup(build) {
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

let supported = false;
let persisted: MessagingConfig = {};
let projectPath: string | null = null;
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init);
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/fs/home') return Response.json({ home: '/test' });
  if (pathname === '/api/location') return Response.json({ directory: '/test', project: { id: 'project', directory: '/test', canonical: '/test' } });
  if (pathname === '/api/config/settings') return Response.json(request.method === 'PUT' ? await request.json() : {});
  if (pathname === '/api/config/messaging') {
    if (request.method === 'PUT') {
      const body: { messaging: MessagingConfig | null } = await request.json();
      persisted = body.messaging ?? {};
      return new Response(null, { status: 204 });
    }
    return Response.json({ messaging: persisted, path: '/config/opencode.json', projectPath });
  }
  if (pathname === '/api/messaging/model') return supported
    ? Response.json({ data: { state: 'ready', tier: 'default' } })
    : new Response(null, { status: 404 });
  if (pathname === '/api/messaging/vars') return Response.json({ data: { vars: [], presets: [] } });
  throw new Error(`Unexpected request: ${request.method} ${pathname}`);
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useMessagingSettingsStore } = await import('@/stores/useMessagingSettingsStore');
const { useMessagingStore } = await import('@/stores/useMessagingStore');
const { MessagingPage } = await import('./MessagingPage');
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

afterAll(async () => {
  await act(async () => root.unmount());
  useMessagingStore.getState().reset();
  fetchSpy.mockRestore();
  browser.close();
});

const field = (label: string) => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing ${label} field`);
  return input;
};
const edit = async (label: string, value: string) => {
  const input = field(label);
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing input setter');
  await act(async () => input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  await act(async () => { await useMessagingSettingsStore.getState().load(null); });
};

const fire = (target: Element, type: string) => {
  const init = { bubbles: true, cancelable: true, button: 0 };
  target.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse' }) : new MouseEvent(type, init));
};

test('rechecks support without remounting and edits every embedding runtime override', async () => {
  await act(async () => root.render(<I18nProvider><MessagingPage /></I18nProvider>));
  await act(async () => { await useMessagingStore.getState().checkSupport(); });
  expect(useMessagingStore.getState().support.kind).toBe('unsupported');
  const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Try again');
  if (!retry) throw new Error('Missing support retry button');
  supported = true;
  await act(async () => retry.click());
  await act(async () => { await useMessagingStore.getState().checkSupport(); });
  expect(useMessagingStore.getState().support.kind).toBe('supported');
  expect(field('Search instruction prefix').disabled).toBe(true);

  const toggle = container.querySelector<HTMLElement>('[data-settings-item="messaging.query"] [role="button"]');
  if (!toggle) throw new Error('Missing query-prefix override toggle');
  await act(async () => toggle.click());
  await act(async () => { await useMessagingSettingsStore.getState().load(null); });
  expect(persisted.embedding?.query).toBe('');
  expect(field('Search instruction prefix').disabled).toBe(false);
  await edit('Search instruction prefix', '  Search: ');
  expect(persisted.embedding?.query).toBe('  Search: ');
  await edit('CPU threads', '6');
  await edit('GPU layers', '-1');
  await edit('llama-server executable', ' /custom/llama-server ');
  expect(persisted.embedding).toMatchObject({ query: '  Search: ', threads: 6, gpu_layers: -1, server: '/custom/llama-server' });

  const pooling = container.querySelector<HTMLButtonElement>('button[aria-label="Pooling"]');
  if (!pooling) throw new Error('Missing pooling picker');
  await act(async () => pooling.click());
  const mean = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'mean');
  if (!mean) throw new Error('Missing mean pooling option');
  await act(async () => {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) fire(mean, type);
  });
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) fire(mean, type);
  });
  await act(async () => { await useMessagingSettingsStore.getState().load(null); });
  expect(persisted.embedding?.pooling).toBe('mean');

  for (const label of ['CPU threads', 'GPU layers']) {
    const reset = container.querySelector<HTMLButtonElement>(`button[aria-label="Reset ${label}"]`);
    if (!reset) throw new Error(`Missing ${label} reset`);
    expect(reset.disabled).toBe(false);
    await act(async () => reset.click());
    await act(async () => { await useMessagingSettingsStore.getState().load(null); });
    expect(reset.disabled).toBe(true);
  }
  expect(persisted.embedding?.threads).toBeUndefined();
  expect(persisted.embedding?.gpu_layers).toBeUndefined();
  await edit('CPU threads', '3');
  await edit('CPU threads', '');
  await act(async () => toggle.click());
  await act(async () => { await useMessagingSettingsStore.getState().load(null); });
  expect(persisted.embedding?.threads).toBeUndefined();
  expect(persisted.embedding?.query).toBeUndefined();
  expect(field('Search instruction prefix').disabled).toBe(true);

  projectPath = '/project/opencode.json';
  await act(async () => { await useMessagingSettingsStore.getState().load(null); });
  expect(field('CPU threads').disabled).toBe(true);
  expect(field('GPU layers').disabled).toBe(true);
  expect(field('llama-server executable').disabled).toBe(true);
});
