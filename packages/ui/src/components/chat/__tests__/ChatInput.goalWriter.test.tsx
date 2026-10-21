import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { GoalSpecJob } from '@/stores/goalSpecJobStore';

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
// answered here, everything else answers empty. An answer takes a moment, as
// over a network: the composer renders before it arrives.
spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = new Request(input instanceof Request ? input : new URL(input.toString(), 'http://localhost/'), init);
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/goals/spec-jobs')) {
    const body = await request.text();
    const call: Call = { method: request.method, path, body: body ? JSON.parse(body) : undefined };
    requests.push(call);
    await new Promise((done) => setTimeout(done, 20));
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
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { useSessionGoalArmStore } = await import('@/stores/useSessionGoalArmStore');
const { useGoalSpecJobStore } = await import('@/stores/goalSpecJobStore');
const { opencodeClient } = await import('@/lib/opencode/client');
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

/** Mounts a composer on one session, or on a new-chat draft; the returned editor reads and types its text. */
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
  return {
    view,
    /** Types into the editor and submits the composer's form, as Enter does, then waits until `settled`. */
    send: async (text: string, settled: () => boolean) => {
      await act(async () => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.type' });
      });
      const form = container.querySelector('form');
      if (!form) throw new Error('The composer form did not mount');
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      for (let turn = 0; turn < 50 && !settled(); turn += 1) {
        await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
      }
      // The answer, and what the composer does with it.
      await act(async () => { await new Promise((done) => setTimeout(done, 60)); });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

type JobFixture = GoalSpecJob;
const writingJob = (trigger: JobFixture['trigger']): JobFixture => ({
  id: 'job-composer',
  sessionId: SESSION_ID,
  directory: '/workspace',
  status: 'writing',
  trigger,
  review: true,
  sendMode: 'with-message',
  tokenBudget: null,
  message: { content: 'Add dark mode', text: 'Add dark mode', attachments: [], contextCount: 0 },
  composerOnly: false,
  spec: null,
  writer: { source: 'session', providerID: 'p', modelID: 'm', variant: null },
  sendConfig: { providerID: 'p', modelID: 'm' },
  error: null,
  sending: false,
  outcome: null,
  attempt: 1,
  createdAt: 1,
  updatedAt: 1,
});

afterAll(() => {
  browser.close();
});

describe('the composer and the goal writer', () => {
  const originalSendMessage = useSessionUIStore.getState().sendMessage;
  let directSends = 0;
  // The sync provider reads the jobs when it mounts; what the composer does is the rest.
  const actions = () => requests.filter((call) => call.method !== 'GET');
  const sentOrStarted = () => actions().length > 0 || directSends > 0;

  beforeEach(() => {
    requests.length = 0;
    directSends = 0;
    respondToGoalJobs = () => Response.json({ revision: 0, jobs: [] });
    useInputStore.setState({ pendingComposerEdits: [], pendingSyntheticParts: null });
    useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
    useUIStore.setState({
      sessionGoalEnabled: true,
      sessionGoalWriterEnabled: true,
      sessionGoalWriterReview: true,
      sessionGoalWriterSendMode: 'with-message',
      sessionGoalRewriteAll: false,
      sessionGoalAutoCreate: 'off',
      sessionGoalDefaultBudgetEnabled: false,
    });
    useSessionGoalArmStore.getState().setArmed(false);
    useGoalSpecJobStore.getState().resetForRuntimeSwitch();
    // A message the writer takes is never sent from the composer.
    useSessionUIStore.setState({
      sendMessage: async () => {
        directSends += 1;
      },
    });
  });

  afterAll(() => {
    useSessionUIStore.setState({ sendMessage: originalSendMessage });
  });

  test('an armed send starts a goal writer job, and the message leaves the composer as a queued one does', async () => {
    useSessionGoalArmStore.getState().setArmed(true);
    respondToGoalJobs = (call) => (call.method === 'GET'
      ? Response.json({ revision: 0, jobs: [] })
      : Response.json({ revision: 1, job: writingJob('armed') }));
    const composer = await mountComposer();
    try {
      await composer.send('Add dark mode', sentOrStarted);

      expect(actions()).toEqual([{
        method: 'POST',
        path: '/api/goals/spec-jobs',
        body: {
          sessionId: SESSION_ID,
          directory: '/workspace',
          trigger: 'armed',
          review: true,
          sendMode: 'with-message',
          tokenBudget: null,
          message: {
            content: 'Add dark mode',
            text: 'Add dark mode',
            attachments: [],
            context: [],
            sendConfig: { providerID: 'p', modelID: 'm' },
          },
          sendConfig: { providerID: 'p', modelID: 'm' },
        },
      }]);
      expect(directSends).toBe(0);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(composer.view.state.doc.toString()).toBe('');
      // The server writes the goal from here on; the arm was for this message.
      expect(useSessionGoalArmStore.getState().armed).toBe(false);
      expect(useGoalSpecJobStore.getState().jobs[SESSION_ID]?.id).toBe('job-composer');
    } finally {
      await composer.unmount();
    }
  });

  test('a goal from the next message starts a job without review when set to run automatically', async () => {
    useUIStore.setState({ sessionGoalAutoCreate: 'auto' });
    respondToGoalJobs = (call) => (call.method === 'GET'
      ? Response.json({ revision: 0, jobs: [] })
      : Response.json({ revision: 1, job: writingJob('auto-create') }));
    const composer = await mountComposer();
    try {
      await composer.send('Add dark mode', sentOrStarted);

      expect(actions()[0]?.body.trigger).toBe('auto-create');
      expect(actions()[0]?.body.review).toBe(false);
      expect(actions()[0]?.body.writerInput).toEqual({ conversation: '', openItems: '' });
      expect(directSends).toBe(0);
    } finally {
      await composer.unmount();
    }
  });

  test('a start the server refuses gives the message back and keeps the goal armed', async () => {
    useSessionGoalArmStore.getState().setArmed(true);
    respondToGoalJobs = (call) => (call.method === 'GET'
      ? Response.json({ revision: 0, jobs: [] })
      : Response.json({ error: 'the session already has a goal spec waiting' }, { status: 409 }));
    const composer = await mountComposer();
    try {
      await composer.send('Add dark mode', sentOrStarted);

      expect(actions()).toHaveLength(1);
      expect(composer.view.state.doc.toString()).toBe('Add dark mode');
      expect(useSessionGoalArmStore.getState().armed).toBe(true);
      expect(directSends).toBe(0);
    } finally {
      await composer.unmount();
    }
  });

  test('while a session\'s goal spec is still open, its next message is not another goal from the next message', async () => {
    useUIStore.setState({ sessionGoalAutoCreate: 'auto' });
    useGoalSpecJobStore.getState().applyServerJob(SESSION_ID, writingJob('auto-create'), 1, getRuntimeKey());
    const composer = await mountComposer();
    try {
      await composer.send('And add a toggle', sentOrStarted);

      expect(actions()).toEqual([]);
      expect(directSends).toBe(1);
    } finally {
      await composer.unmount();
    }
  });

  test('a new chat becomes a session first, and the job starts in it', async () => {
    useSessionGoalArmStore.getState().setArmed(true);
    const originalCreateSession = opencodeClient.createSession;
    const createdIn: Array<string | null | undefined> = [];
    opencodeClient.createSession = async (_params, directory) => {
      createdIn.push(directory);
      return {
        id: 'ses_from_draft',
        projectID: 'project',
        directory: '/workspace',
        title: 'New chat',
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      };
    };
    respondToGoalJobs = (call) => (call.method === 'GET'
      ? Response.json({ revision: 0, jobs: [] })
      : Response.json({ revision: 1, job: { ...writingJob('armed'), sessionId: 'ses_from_draft' } }));
    const composer = await mountComposer('draft');
    try {
      await composer.send('Add dark mode', sentOrStarted);

      expect(createdIn).toEqual(['/workspace']);
      expect(actions().map((call) => [call.method, call.path, call.body.sessionId, call.body.directory])).toEqual([
        ['POST', '/api/goals/spec-jobs', 'ses_from_draft', '/workspace'],
      ]);
      expect(useSessionUIStore.getState().currentSessionId).toBe('ses_from_draft');
      expect(directSends).toBe(0);
    } finally {
      opencodeClient.createSession = originalCreateSession;
      await composer.unmount();
    }
  });

  test('without the writer an armed message is sent from the composer, no job', async () => {
    useUIStore.setState({ sessionGoalWriterEnabled: false });
    useSessionGoalArmStore.getState().setArmed(true);
    const composer = await mountComposer();
    try {
      await composer.send('Add dark mode', sentOrStarted);

      expect(actions()).toEqual([]);
      expect(directSends).toBe(1);
    } finally {
      await composer.unmount();
    }
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
