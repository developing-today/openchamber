import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { GoalSpecJob } from '@/stores/goalSpecJobStore';
import type { SessionGoalArm } from '@/stores/useSessionGoalArmStore';

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
let respondToGoalJobs: (call: Call) => Response | Promise<Response> = () => Response.json({ revision: 0, jobs: [] });
const queueRequests: Call[] = [];
let queueRevision = 0;
/** The session's queue on the server, as the composer's requests left it. */
let serverItems: Array<ReturnType<typeof JSON.parse>> = [];
/**
 * The message queue as the server answers: a new item joins the session's
 * queue under an id the server gives it, and a take hands items back.
 */
const answerQueue = (call: Call): Response => {
  queueRevision += 1;
  const session = () => ({ sessionId: SESSION_ID, directory: '/workspace', items: serverItems, sendingId: null });
  if (call.method === 'GET') return Response.json({ revision: queueRevision, sessions: serverItems.length > 0 ? [session()] : [] });
  if (call.path.endsWith('/items')) {
    serverItems = [...serverItems, { id: `queued-${queueRevision}`, createdAt: 1, ...call.body.item }];
    return Response.json({ revision: queueRevision, session: session() });
  }
  if (!call.path.includes('/items/')) {
    const items = serverItems;
    serverItems = [];
    return Response.json({ revision: queueRevision, session: session(), items });
  }
  const item = serverItems.find((entry) => call.path.endsWith(`/items/${entry.id}/take`));
  serverItems = serverItems.filter((entry) => entry !== item);
  return Response.json({ revision: queueRevision, session: session(), item });
};
let respondToQueue: (call: Call) => Response | Promise<Response> = answerQueue;

// Nothing reaches a server: goal writer job and message queue requests are
// recorded and answered here, everything else answers empty. An answer takes
// a moment, as over a network: the composer renders before it arrives.
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
  if (path.startsWith('/api/message-queue')) {
    const body = await request.text();
    const call: Call = { method: request.method, path, body: body ? JSON.parse(body) : undefined };
    queueRequests.push(call);
    await new Promise((done) => setTimeout(done, 20));
    return respondToQueue(call);
  }
  if (path.endsWith('/location')) {
    return Response.json({ directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } });
  }
  // A response style is on, so a session's first message carries it.
  if (path === '/api/config/settings') return Response.json({ responseStyleEnabled: true, responseStylePreset: 'concise' });
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
const { useMessageQueueStore } = await import('@/stores/messageQueueStore');
const { getSyncChildStores } = await import('@/sync/sync-refs');
const { clearChatDraft, createChatDraftIdentity } = await import('@/lib/chatDraftPersistence');
const { opencodeClient } = await import('@/lib/opencode/client');
const { getResponseStylePresetInstructions } = await import('@/lib/responseStyle');
const { wrapSystemReminder } = await import('@/lib/systemReminder');
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
  /** Waits until `settled`, then for the answer and what the composer does with it. */
  const waitFor = async (settled: () => boolean) => {
    for (let turn = 0; turn < 50 && !settled(); turn += 1) {
      await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
    }
    await act(async () => { await new Promise((done) => setTimeout(done, 60)); });
  };
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
      await waitFor(settled);
    },
    /** Whether the agent is working in the session: while it is, a send follows the follow-up setting. */
    setStatus: async (type: 'busy' | 'idle') => {
      await act(async () => {
        const store = getSyncChildStores().getChild('/workspace');
        if (!store) throw new Error('The session\'s directory store did not mount');
        store.setState({ session_status: { [SESSION_ID]: { type } } });
      });
    },
    /** Clicks a queued message's button (`edit` or `send`), then waits until `settled`. */
    clickQueued: async (label: 'edit' | 'send', settled: () => boolean) => {
      const queue = container.querySelector('[role="group"][aria-label="Queued messages"]');
      const button = Array.from(queue?.querySelectorAll('button') ?? []).find((candidate) => candidate.textContent?.trim() === label);
      if (!button) throw new Error(`The queued message has no ${label} button`);
      await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await waitFor(settled);
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
          newSession: false,
          message: {
            content: 'Add dark mode',
            text: 'Add dark mode',
            attachments: [],
            // The session's first message carries the response style, as a direct send does.
            context: [{ kind: 'instruction', text: wrapSystemReminder(getResponseStylePresetInstructions('concise')) }],
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
      expect(actions().map((call) => [call.method, call.path, call.body.sessionId, call.body.directory, call.body.newSession])).toEqual([
        ['POST', '/api/goals/spec-jobs', 'ses_from_draft', '/workspace', true],
      ]);
      expect(actions()[0]?.body.message.context).toEqual([
        { kind: 'instruction', text: wrapSystemReminder(getResponseStylePresetInstructions('concise')) },
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
          target: { kind: 'session', sessionId: SESSION_ID },
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

  test('a new chat\'s job taken back goes to the new-session draft that took its session\'s place, and only that draft', async () => {
    const composer = await mountComposer('draft');
    try {
      const draftId = useSessionUIStore.getState().newSessionDraft.draftId;
      await act(async () => {
        useInputStore.getState().requestComposerEdit({
          runtimeKey: getRuntimeKey(),
          target: { kind: 'draft', draftId: draftId + 1 },
          content: 'For another draft',
          attachments: [],
          context: [],
        });
        useInputStore.getState().requestComposerEdit({
          runtimeKey: getRuntimeKey(),
          target: { kind: 'draft', draftId },
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
          context: [{ kind: 'synthetic', text: 'Resolve the conflict' }],
        });
      });
      await act(async () => { await new Promise((done) => setTimeout(done, 0)); });

      expect(composer.view.state.doc.toString()).toBe('Add dark mode');
      expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(['mock.png']);
      expect(useInputStore.getState().getPendingSyntheticParts(null)).toEqual([{ text: 'Resolve the conflict', synthetic: true }]);
      // The message for another draft waits for that draft.
      expect(useInputStore.getState().pendingComposerEdits.map((edit) => edit.content)).toEqual(['For another draft']);
    } finally {
      await composer.unmount();
    }
  });
});

// A message sent while the agent works joins the queue (the default follow-up
// setting). A goal armed for it must go with it, never stay on the composer.
describe('a message queued while the agent works, with a goal armed', () => {
  const originalSendMessage = useSessionUIStore.getState().sendMessage;
  const sends: Array<{ text: string; goalArm: SessionGoalArm | undefined }> = [];
  const jobStarts = () => requests.filter((call) => call.method === 'POST' && call.path === '/api/goals/spec-jobs');
  const queued = () => queueRequests.filter((call) => call.method === 'POST' && call.path === `/api/message-queue/sessions/${SESSION_ID}/items`);
  const takes = () => queueRequests.filter((call) => call.path.endsWith('/take'));
  const anything = () => jobStarts().length > 0 || queued().length > 0 || sends.length > 0;
  const plainArm: SessionGoalArm = { armed: true, objectiveOverride: null, settled: false, briefAgent: false, ignoreLimit: false };
  const settleAnswers = async () => {
    await act(async () => { await new Promise((done) => setTimeout(done, 80)); });
  };

  beforeEach(() => {
    requests.length = 0;
    queueRequests.length = 0;
    serverItems = [];
    sends.length = 0;
    respondToGoalJobs = () => Response.json({ revision: 0, jobs: [] });
    respondToQueue = answerQueue;
    // A test before this one can leave text and a file in the session's composer.
    const draft = createChatDraftIdentity(getRuntimeKey(), '/workspace', SESSION_ID);
    if (draft) clearChatDraft(draft);
    useInputStore.setState({ pendingComposerEdits: [], pendingSyntheticParts: null, attachedFiles: [], attachmentDraftKey: null, attachmentDrafts: new Map() });
    useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
    useUIStore.setState({
      sessionGoalEnabled: true,
      sessionGoalWriterEnabled: false,
      sessionGoalWriterReview: true,
      sessionGoalWriterSendMode: 'with-message',
      sessionGoalRewriteAll: false,
      sessionGoalAutoCreate: 'off',
      sessionGoalDefaultBudgetEnabled: true,
      sessionGoalDefaultBudget: 50_000,
    });
    useSessionGoalArmStore.getState().setArmed(false);
    useGoalSpecJobStore.getState().resetForRuntimeSwitch();
    useMessageQueueStore.setState({ followUpBehavior: 'queue', queuedMessages: {}, sendingIds: {} });
    // A test before this one can leave a new-session draft open, which hides the queue.
    useSessionUIStore.setState({ newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: false } });
    useSessionUIStore.setState({
      sendMessage: async (content, _providerID, _modelID, _agent, _attachments, _mention, _parts, _variant, _mode, options) => {
        sends.push({ text: content, goalArm: options?.goalArm });
      },
    });
  });

  afterAll(() => {
    useSessionUIStore.setState({ sendMessage: originalSendMessage });
  });

  test('without the writer the queued message carries the goal and its budget, and the composer is no longer armed', async () => {
    useSessionGoalArmStore.getState().setArmed(true);
    const composer = await mountComposer();
    try {
      await composer.setStatus('busy');
      await composer.send('Add dark mode', anything);

      expect(queued().map((call) => call.body)).toEqual([{
        directory: '/workspace',
        item: {
          content: 'Add dark mode',
          text: 'Add dark mode',
          attachments: [],
          context: [],
          sendConfig: { providerID: 'p', modelID: 'm' },
          goal: { tokenBudget: 50_000 },
        },
      }]);
      expect(jobStarts()).toEqual([]);
      expect(sends).toEqual([]);
      expect(composer.view.state.doc.toString()).toBe('');
      expect(useSessionGoalArmStore.getState().armed).toBe(false);
      // The queue the composer shows knows which message starts a goal.
      expect(Object.values(useMessageQueueStore.getState().queuedMessages).flat().map((message) => message.goal)).toEqual([{ tokenBudget: 50_000 }]);
    } finally {
      await composer.unmount();
    }
  });

  test('with the writer the message starts a goal writer job and does not join the queue', async () => {
    useUIStore.setState({ sessionGoalWriterEnabled: true });
    useSessionGoalArmStore.getState().setArmed(true);
    respondToGoalJobs = (call) => (call.method === 'GET'
      ? Response.json({ revision: 0, jobs: [] })
      : Response.json({ revision: 1, job: writingJob('armed') }));
    const composer = await mountComposer();
    try {
      await composer.setStatus('busy');
      await composer.send('Add dark mode', anything);

      expect(jobStarts().map((call) => [call.body.trigger, call.body.message.text, call.body.tokenBudget])).toEqual([
        ['armed', 'Add dark mode', 50_000],
      ]);
      expect(queued()).toEqual([]);
      expect(sends).toEqual([]);
      expect(composer.view.state.doc.toString()).toBe('');
      expect(useSessionGoalArmStore.getState().armed).toBe(false);
    } finally {
      await composer.unmount();
    }
  });

  test('the goal goes with one message: one sent while the first is being queued is queued plain', async () => {
    useSessionGoalArmStore.getState().setArmed(true);
    // The first message's answer waits until the second one is queued.
    let releaseFirst = () => {};
    respondToQueue = (call) => (call.path.endsWith('/items') && queued().length === 1
      ? new Promise<Response>((resolve) => { releaseFirst = () => resolve(answerQueue(call)); })
      : answerQueue(call));
    const composer = await mountComposer();
    try {
      await composer.setStatus('busy');
      await composer.send('Add dark mode', () => queued().length === 1);
      await composer.send('And a toggle', () => queued().length === 2);
      releaseFirst();
      await settleAnswers();

      expect(queued().map((call) => [call.body.item.text, call.body.item.goal])).toEqual([
        ['Add dark mode', { tokenBudget: 50_000 }],
        ['And a toggle', undefined],
      ]);
      expect(useSessionGoalArmStore.getState().armed).toBe(false);
    } finally {
      await composer.unmount();
    }
  });

  test('with the writer, a message sent while the job starts is queued plain, not a second goal', async () => {
    useUIStore.setState({ sessionGoalWriterEnabled: true });
    useSessionGoalArmStore.getState().setArmed(true);
    let releaseJob = () => {};
    respondToGoalJobs = (call) => (call.method === 'GET'
      ? Response.json({ revision: 0, jobs: [] })
      : new Promise<Response>((resolve) => { releaseJob = () => resolve(Response.json({ revision: 1, job: writingJob('armed') })); }));
    const composer = await mountComposer();
    try {
      await composer.setStatus('busy');
      await composer.send('Add dark mode', () => jobStarts().length === 1);
      await composer.send('And a toggle', () => queued().length === 1);
      releaseJob();
      await settleAnswers();

      expect(jobStarts().map((call) => call.body.message.text)).toEqual(['Add dark mode']);
      expect(queued().map((call) => [call.body.item.text, call.body.item.goal])).toEqual([['And a toggle', undefined]]);
      expect(useSessionGoalArmStore.getState().armed).toBe(false);
    } finally {
      await composer.unmount();
    }
  });

  test('a message queued without a goal armed is queued as before, with the writer on too', async () => {
    useUIStore.setState({ sessionGoalWriterEnabled: true });
    const composer = await mountComposer();
    try {
      await composer.setStatus('busy');
      await composer.send('Add dark mode', anything);

      expect(queued().map((call) => call.body)).toEqual([{
        directory: '/workspace',
        item: { content: 'Add dark mode', text: 'Add dark mode', attachments: [], context: [], sendConfig: { providerID: 'p', modelID: 'm' } },
      }]);
      expect(jobStarts()).toEqual([]);
      expect(sends).toEqual([]);
      expect(useSessionGoalArmStore.getState().armed).toBe(false);
    } finally {
      await composer.unmount();
    }
  });

  test('a message the queue refuses comes back to the composer with its goal armed again', async () => {
    useSessionGoalArmStore.getState().setArmed(true);
    respondToQueue = (call) => (call.path.endsWith('/items')
      ? Response.json({ error: 'message queue is full' }, { status: 409 })
      : answerQueue(call));
    const composer = await mountComposer();
    try {
      await composer.setStatus('busy');
      await composer.send('Add dark mode', anything);

      expect(queued()).toHaveLength(1);
      expect(composer.view.state.doc.toString()).toBe('Add dark mode');
      expect(useSessionGoalArmStore.getState().armed).toBe(true);
    } finally {
      await composer.unmount();
    }
  });

  test('a queued goal message taken back for editing arms the composer again', async () => {
    useSessionGoalArmStore.getState().setArmed(true);
    const composer = await mountComposer();
    try {
      await composer.setStatus('busy');
      await composer.send('Add dark mode', () => queued().length === 1);
      expect(useSessionGoalArmStore.getState().armed).toBe(false);

      await composer.clickQueued('edit', () => takes().length === 1);

      expect(composer.view.state.doc.toString()).toBe('Add dark mode');
      expect(useSessionGoalArmStore.getState().armed).toBe(true);
    } finally {
      await composer.unmount();
    }
  });

  test('sending a queued goal message now passes its goal with that send and leaves the composer\'s arm alone', async () => {
    useSessionGoalArmStore.getState().setArmed(true);
    const composer = await mountComposer();
    try {
      await composer.setStatus('busy');
      await composer.send('Add dark mode', () => queued().length === 1);
      // The user arms a goal for the next message they type.
      useSessionGoalArmStore.getState().setArmed(true);

      await composer.clickQueued('send', () => sends.length > 0);

      expect(takes().map((call) => call.method)).toEqual(['POST']);
      expect(sends).toEqual([{ text: 'Add dark mode', goalArm: plainArm }]);
      expect(useSessionGoalArmStore.getState().armed).toBe(true);
    } finally {
      await composer.unmount();
    }
  });

  test('a send that takes a queued goal message along carries the goal, and the composer\'s arm with its own text', async () => {
    useSessionGoalArmStore.getState().setArmed(true);
    const composer = await mountComposer();
    try {
      await composer.setStatus('busy');
      await composer.send('Add dark mode', () => queued().length === 1);
      // The turn ends before the server delivers it, and the user sends another message, armed.
      await composer.setStatus('idle');
      useSessionGoalArmStore.getState().setArmed(true);

      await composer.send('And a toggle', () => sends.length > 0);

      expect(sends).toEqual([{ text: 'Add dark mode\n\nAnd a toggle', goalArm: plainArm }]);
      expect(useSessionGoalArmStore.getState().armed).toBe(false);
    } finally {
      await composer.unmount();
    }
  });
});
