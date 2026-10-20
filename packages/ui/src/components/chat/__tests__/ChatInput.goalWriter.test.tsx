import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';

// Mounts the real composer, as ChatInput.keystroke.test.tsx does, to check
// what it does with the goal writer: where a message sent through the writer
// goes, and what comes back when its job is taken back for editing.

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

type Call = { method: string; path: string; body: ReturnType<typeof JSON.parse> };
const requests: Call[] = [];
let respondToGoalJobs: (call: Call) => Response = () => Response.json({ revision: 0, jobs: [] });

// Nothing reaches a server: goal writer job requests are recorded and
// answered here, everything else answers empty.
spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = new Request(input instanceof Request ? input : new URL(input.toString(), 'http://localhost/'), init);
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/goals/spec-jobs')) {
    const body = await request.text();
    const call: Call = { method: request.method, path, body: body ? JSON.parse(body) : undefined };
    requests.push(call);
    return respondToGoalJobs(call);
  }
  if (path.endsWith('/location')) {
    return Response.json({ directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } });
  }
  if (path.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({});
});

// Vite-only module forms the composer's import graph reaches; see ChatInput.keystroke.test.tsx.
plugin({
  name: 'composer-goal-writer-vite-modules',
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
const { EditorView } = await import('@codemirror/view');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useInputStore } = await import('@/sync/input-store');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
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

// SAFETY: Mounting and submitting read only the runtime descriptor and the
// source-control object's identity; no runtime API method is invoked.
const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;

const SESSION_ID = 'ses_goal_writer';

/** Mounts a composer on one session; the returned editor reads and types its text. */
const mountComposer = async () => {
  useDirectoryStore.setState({ currentDirectory: '/workspace' });
  useSessionUIStore.setState({ currentSessionId: SESSION_ID, currentSessionDirectory: '/workspace' });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <ThemeSystemProvider>
          <I18nProvider>
            <SyncProvider sdk={sdk} directory="/workspace">
              <ChatInput />
            </SyncProvider>
          </I18nProvider>
        </ThemeSystemProvider>
      </RuntimeAPIContext.Provider>,
    );
  });
  await act(async () => { await new Promise((done) => setTimeout(done, 50)); });
  const content = container.querySelector<HTMLElement>('.cm-content');
  const view = content ? EditorView.findFromDOM(content) : null;
  if (!view) throw new Error('The composer editor did not mount');
  return {
    view,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

afterAll(() => {
  browser.close();
});

describe('the composer and the goal writer', () => {
  beforeEach(() => {
    requests.length = 0;
    respondToGoalJobs = () => Response.json({ revision: 0, jobs: [] });
    useInputStore.setState({ pendingComposerEdits: [], pendingSyntheticParts: null });
  });

  test('a job taken back for editing returns its text, files and chips to the session\'s composer', async () => {
    const composer = await mountComposer();
    try {
      await act(async () => {
        useInputStore.getState().requestComposerEdit({
          runtimeKey: getRuntimeKey(),
          sessionId: SESSION_ID,
          content: 'Add dark mode',
          attachments: [{
            id: 'a1',
            file: new File(['hi'], 'mock.png', { type: 'image/png' }),
            dataUrl: 'data:image/png;base64,aGk=',
            mimeType: 'image/png',
            filename: 'mock.png',
            size: 2,
            source: 'local',
          }],
          context: [{ kind: 'synthetic', text: 'Resolve the conflict' }, { kind: 'instruction', text: 'Load the skill' }],
        });
      });
      await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

      expect(composer.view.state.doc.toString()).toBe('Add dark mode');
      expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(['mock.png']);
      // Attached chips come back; an instruction derived from the text is derived again on send.
      expect(useInputStore.getState().getPendingSyntheticParts(null)).toEqual([{ text: 'Resolve the conflict', synthetic: true }]);
      expect(useInputStore.getState().pendingComposerEdits).toEqual([]);
    } finally {
      await composer.unmount();
    }
  });
});
