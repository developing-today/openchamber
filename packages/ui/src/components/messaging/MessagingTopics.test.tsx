import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, DocumentFragment: browser.DocumentFragment,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

let description = 'initial description';
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init);
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/fs/home') return Response.json({ home: '/test' });
  if (pathname === '/api/location') return Response.json({ directory: '/test', project: { id: 'project', directory: '/test', canonical: '/test' } });
  if (pathname === '/api/messaging/topic') return Response.json({ data: {
    name: 'notes', exists: true, kind: 'custom', mode: 'open', writers: [],
    policy: 'anyone writes', messages: 0, description,
  } });
  if (pathname === '/api/messaging/query') return Response.json({ data: { messages: [], more: false } });
  throw new Error(`Unexpected request: ${request.method} ${pathname}`);
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useMessagingStore } = await import('@/stores/useMessagingStore');
const { MessagingTopics } = await import('./MessagingTopics');
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

afterAll(async () => {
  await act(async () => root.unmount());
  useMessagingStore.getState().reset();
  fetchSpy.mockRestore();
  browser.close();
});

test('a topic refresh preserves an open settings draft and reopening uses the latest topic', async () => {
  useMessagingStore.getState().openTopicAt('notes');
  await act(async () => root.render(<I18nProvider><MessagingTopics sessionID="ses_a" split={false} active /></I18nProvider>));
  await act(async () => { await useMessagingStore.getState().loadTopic('notes'); });
  const settings = container.querySelector<HTMLButtonElement>('button[aria-label="Topic settings"]');
  if (!settings) throw new Error('Missing topic settings button');
  await act(async () => settings.click());
  const field = document.querySelector<HTMLInputElement>('input[aria-label="Description"]');
  if (!field) throw new Error('Missing description field');
  expect(field.value).toBe('initial description');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing input setter');
  await act(async () => {
    setValue.call(field, 'unsaved draft');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  description = 'updated elsewhere';
  await act(async () => { await useMessagingStore.getState().loadTopic('notes'); });
  expect(field.value).toBe('unsaved draft');
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Cancel');
  if (!cancel) throw new Error('Missing cancel button');
  await act(async () => cancel.click());
  await act(async () => settings.click());
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Description"]')?.value).toBe('updated elsewhere');
});
