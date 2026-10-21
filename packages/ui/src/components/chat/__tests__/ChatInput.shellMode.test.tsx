import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';

// A leading `!` puts the composer in shell mode, and a shell send runs the
// text as a command. Text the composer did not get from its own editor (an
// agent's question answered again from its row, a preset chip, a Shortcuts
// first message) is a message: it never goes out as a shell command, and a
// command the user is typing stays theirs.

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
  name: 'composer-shell-mode-vite-modules',
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
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useInputStore } = await import('@/sync/input-store');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { clearChatDraft, createChatDraftIdentity } = await import('@/lib/chatDraftPersistence');
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

const SESSION_ID = 'ses_shell_mode';
// Option text comes from the agent; as a shell command it would run.
const ANSWERS = 'My answers to your questions:\n- "Which branch?"="$(touch /tmp/answered)"';

type Send = { content: string; inputMode: string | undefined };
const sends: Send[] = [];

const mountComposer = async (on: 'session' | 'draft' = 'session') => {
  useDirectoryStore.setState({ currentDirectory: '/workspace' });
  useSessionUIStore.setState(on === 'session'
    ? { currentSessionId: SESSION_ID, currentSessionDirectory: '/workspace' }
    : {
        currentSessionId: null,
        currentSessionDirectory: null,
        newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: true, target: 'project', directoryOverride: '/workspace' },
      });
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
  const settle = async (done: () => boolean = () => false) => {
    for (let turn = 0; turn < 30 && !done(); turn += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  };
  return {
    view,
    settle,
    /** Types at the end of the editor, as a keyboard does. */
    type: async (text: string) => {
      await act(async () => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.type' });
      });
      await settle();
    },
    clear: async () => {
      await act(async () => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length }, userEvent: 'delete' });
      });
    },
    inShellMode: () => container.querySelector('[data-testid="chat-input"]')?.classList.contains('font-mono') === true,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

afterAll(() => {
  browser.close();
});

describe('text the composer did not get from its editor, in shell mode', () => {
  const originalSendMessage = useSessionUIStore.getState().sendMessage;

  beforeEach(() => {
    sends.length = 0;
    // A test before this one can leave text in the session's or the new chat's composer.
    for (const sessionId of [SESSION_ID, null]) {
      const draft = createChatDraftIdentity(getRuntimeKey(), '/workspace', sessionId);
      if (draft) clearChatDraft(draft);
    }
    useInputStore.setState({ pendingSessionSubmit: null, pendingPresetSubmit: null, pendingDraftSubmit: null, pendingSyntheticParts: null });
    useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm', providersLoaded: true, agentsLoaded: true });
    useSessionUIStore.setState({
      sendMessage: async (content, _providerID, _modelID, _agent, _files, _mention, _parts, _variant, inputMode) => {
        sends.push({ content, inputMode });
      },
    });
  });

  afterAll(() => {
    useSessionUIStore.setState({ sendMessage: originalSendMessage });
  });

  test('answers to an agent\'s question go as a message, and the composer leaves shell mode', async () => {
    const composer = await mountComposer();
    try {
      await composer.type('!');
      expect(composer.inShellMode()).toBe(true);

      await act(async () => {
        useInputStore.getState().requestSessionSubmit({ target: null, sessionId: SESSION_ID, text: ANSWERS });
      });
      await composer.settle(() => sends.length > 0);

      expect(sends).toEqual([{ content: ANSWERS, inputMode: 'normal' }]);
      expect(composer.inShellMode()).toBe(false);
    } finally {
      await composer.unmount();
    }
  });

  test('a shell command being typed stays one: the answers wait until it is gone, then go as a message', async () => {
    const composer = await mountComposer();
    try {
      await composer.type('!');
      await composer.type('ls -la');
      expect(composer.inShellMode()).toBe(true);

      await act(async () => {
        useInputStore.getState().requestSessionSubmit({ target: null, sessionId: SESSION_ID, text: ANSWERS });
      });
      await composer.settle();

      expect(sends).toEqual([]);
      expect(composer.view.state.doc.toString()).toBe('ls -la');
      expect(composer.inShellMode()).toBe(true);
      expect(useInputStore.getState().pendingSessionSubmit?.text).toBe(ANSWERS);

      await composer.clear();
      await composer.settle(() => sends.length > 0);

      expect(sends).toEqual([{ content: ANSWERS, inputMode: 'normal' }]);
      expect(composer.inShellMode()).toBe(false);
    } finally {
      await composer.unmount();
    }
  });

  test('a preset chip goes as a message', async () => {
    const composer = await mountComposer();
    try {
      await composer.type('!');
      expect(composer.inShellMode()).toBe(true);

      await act(async () => {
        useInputStore.getState().requestPresetSubmit('/deploy', 'command');
      });
      await composer.settle(() => sends.length > 0);

      expect(sends).toEqual([{ content: '/deploy', inputMode: 'normal' }]);
      expect(composer.inShellMode()).toBe(false);
    } finally {
      await composer.unmount();
    }
  });

  test('a Shortcuts first message for the open draft goes as a message', async () => {
    const composer = await mountComposer('draft');
    try {
      await composer.type('!');
      expect(composer.inShellMode()).toBe(true);

      await act(async () => {
        useInputStore.getState().requestDraftSubmit(useSessionUIStore.getState().newSessionDraft.draftId, 'Summarize the open pull requests');
      });
      await composer.settle(() => sends.length > 0);

      expect(sends).toEqual([{ content: 'Summarize the open pull requests', inputMode: 'normal' }]);
      expect(composer.inShellMode()).toBe(false);
    } finally {
      await composer.unmount();
    }
  });
});
