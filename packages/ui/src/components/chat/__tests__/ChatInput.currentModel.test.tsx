import { afterAll, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { Message } from '@/lib/opencode/model';

// On desktop the composer shows the real model of the session's last turn as
// a line above its box. It used to be mounted next to the composer form in
// ChatContainer's composer slot, which lays its children out in a row: the
// line sat to the left of the box, cut off (`fake/fake-mo…`), and squeezed
// the box narrower. A DOM without layout cannot show that, so this checks
// where the line is mounted.

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Node: browser.Node,
  Text: browser.Text,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLFormElement: browser.HTMLFormElement,
  Range: browser.Range,
  Selection: browser.Selection,
  DocumentFragment: browser.DocumentFragment,
  Event: browser.Event,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  FocusEvent: browser.FocusEvent,
  InputEvent: browser.InputEvent,
  CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  matchMedia: browser.matchMedia.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements,
  HTMLDivElement: browser.HTMLDivElement,
  HTMLSpanElement: browser.HTMLSpanElement,
  SVGElement: browser.SVGElement,
  ShadowRoot: browser.ShadowRoot,
  CSSStyleSheet: browser.CSSStyleSheet,
  DOMParser: browser.DOMParser,
  IS_REACT_ACT_ENVIRONMENT: true,
});

// Nothing here reaches a server; every request answers empty.
spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
  if (path.endsWith('/location')) {
    return Response.json({ directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } });
  }
  if (path.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({});
});

// Vite-only module forms the composer's import graph reaches, loaded the way
// `ChatInput.keystroke.test.tsx` loads them.
plugin({
  name: 'composer-current-model-vite-modules',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider, useDirectoryStore: useSyncDirectoryStore } = await import('@/sync/sync-context');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useUIStore } = await import('@/stores/useUIStore');
const { OpenCode } = await import('@opencode/client');

const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/location')
      ? { directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

// SAFETY: Mounting the composer reads only the runtime descriptor and the
// source-control object's identity; no runtime API method is invoked.
const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;

const SESSION_ID = 'ses_current_model';

const lastReply: Message = {
  id: 'msg_reply',
  sessionID: SESSION_ID,
  role: 'assistant',
  time: { created: 1 },
  agent: 'build',
  providerID: 'fake',
  modelID: 'fake-model',
};

let sessionStore: ReturnType<typeof useSyncDirectoryStore> | null = null;
const StoreProbe = () => {
  sessionStore = useSyncDirectoryStore('/workspace', { bootstrap: false });
  return null;
};

afterAll(() => {
  browser.close();
});

test('desktop shows the current model as an opaque pill of the composer column, above the box', async () => {
  useUIStore.setState({ isMobile: false });
  useDirectoryStore.setState({ currentDirectory: '/workspace' });
  useSessionUIStore.setState({ currentSessionId: SESSION_ID, currentSessionDirectory: '/workspace' });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}>
          <ThemeSystemProvider>
            <I18nProvider>
              <SyncProvider sdk={sdk} directory="/workspace">
                <StoreProbe />
                <ChatInput />
              </SyncProvider>
            </I18nProvider>
          </ThemeSystemProvider>
        </RuntimeAPIContext.Provider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    if (!sessionStore) throw new Error('The session store probe did not mount');
    const store = sessionStore;
    await act(async () => store.setState({ message: { [SESSION_ID]: [lastReply] } }));

    const indicators = container.querySelectorAll('[data-current-model-indicator]');
    expect(indicators).toHaveLength(1);
    const indicator = indicators[0];
    expect(indicator?.textContent).toBe('fake/fake-model');
    // It sits over the scrolling transcript, outside the box's opaque
    // surface, so it carries an opaque surface of its own: a transparent line
    // let the transcript's text show through it.
    expect(indicator?.classList.contains('oc-surface-floating')).toBe(true);
    expect(indicator?.classList.contains('oc-glass-floating')).toBe(true);

    // Inside the composer form, as a line of its column, ahead of the box
    // that holds the editor: never a sibling of the form, never in the box.
    const column = indicator?.parentElement;
    const editor = container.querySelector('[data-testid="chat-input"]');
    if (!indicator || !column || !editor) throw new Error('Expected the indicator and the composer editor');
    expect(column.classList.contains('chat-input-column')).toBe(true);
    expect(column.closest('form')).not.toBeNull();
    expect(column.contains(editor)).toBe(true);
    expect(indicator.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
