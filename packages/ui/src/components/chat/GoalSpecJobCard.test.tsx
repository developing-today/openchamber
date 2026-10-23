import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { I18nProvider } from '@/lib/i18n';
import { opencodeClient, type MessagePage } from '@/lib/opencode/client';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useGoalSpecJobStore, type GoalSpecJob } from '@/stores/goalSpecJobStore';
import { useSessionGoalArmStore, type SessionGoalArm } from '@/stores/useSessionGoalArmStore';
import { ChildStoreManager } from '@/sync/child-store';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { setSyncRefs } from '@/sync/sync-refs';
import { ChatColumnTakesPromptsContext } from './chatColumnSession';
import { GoalSpecJobCard } from './GoalSpecJobCard';
import { takeGoalSpecJobBack } from './goalSpecJobEdit';
import { sendGoalSpecJob } from './goalSpecJobSend';

// The stores above load without a DOM, as their own tests load them. React
// DOM probes for one when first imported: give the probe a document, then
// restore the caller's globals.
const importWindow = new Window();
const importGlobals = ['window', 'document'] as const;
const previousImportGlobals = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
for (const [name, descriptor] of previousImportGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, HTMLTextAreaElement: win.HTMLTextAreaElement, Event: win.Event, localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { win, container, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    void win.happyDOM.close();
  } };
};

type Call = { method: string; path: string; body: ReturnType<typeof JSON.parse> };
type SendMessage = ReturnType<typeof useSessionUIStore.getState>['sendMessage'];

const job = (overrides: Partial<GoalSpecJob> = {}): GoalSpecJob => ({
  id: 'job-1',
  sessionId: 'ses_card',
  directory: '/repo',
  status: 'writing',
  trigger: 'armed',
  review: true,
  sendMode: 'with-message',
  tokenBudget: null,
  message: { content: 'Add dark mode\nto settings', text: 'Add dark mode\nto settings', attachments: [], contextCount: 0 },
  composerOnly: false,
  spec: null,
  writer: { source: 'settings', providerID: 'p', modelID: 'm', variant: 'high' },
  sendConfig: { providerID: 'p', modelID: 'm', agent: 'build' },
  error: null,
  sending: false,
  outcome: null,
  attempt: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const show = (value: GoalSpecJob) => useGoalSpecJobStore.getState().applyServerJob(value.sessionId, value, 1, getRuntimeKey());

const originalFetch = globalThis.fetch;
const originalSendMessage = useSessionUIStore.getState().sendMessage;

describe('GoalSpecJobCard', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let calls: Call[];
  let respond: (call: Call) => Response;

  const render = (sessionId = 'ses_card', takesPrompts = true) => act(async () => root.render(
    <I18nProvider>
      <ChatColumnTakesPromptsContext.Provider value={takesPrompts}>
        <GoalSpecJobCard sessionId={sessionId} />
      </ChatColumnTakesPromptsContext.Provider>
    </I18nProvider>,
  ));
  const findButton = (label: string): HTMLButtonElement | null => (
    Array.from(document.querySelectorAll('button')).find((element) => (
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label
    )) ?? null
  );
  const click = async (label: string) => {
    const button = findButton(label);
    if (!button) throw new Error(`No button "${label}" in: ${document.body.textContent}`);
    await act(async () => { button.click(); });
    // The action's request and the answer it applies.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const text = () => document.body.textContent ?? '';

  beforeEach(() => {
    calls = [];
    respond = () => Response.json({ revision: 2, job: null });
    dom = installDom();
    root = createRoot(dom.container);
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = await request.text();
      const call: Call = { method: request.method, path: new URL(request.url).pathname, body: body ? JSON.parse(body) : undefined };
      // The writer picker reads Settings and the small model; only the job's
      // own requests are recorded here.
      if (!call.path.startsWith('/api/goals/spec-jobs')) return Response.json({});
      calls.push(call);
      return respond(call);
    }, originalFetch);
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://goal-card.test' });
    useGoalSpecJobStore.getState().resetForRuntimeSwitch();
    useSessionGoalArmStore.getState().setArmed(false);
    useInputStore.setState({ pendingComposerEdits: [] });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
    globalThis.fetch = originalFetch;
    configureRuntimeUrlResolver({ apiBaseUrl: '' });
    useSessionUIStore.setState({ sendMessage: originalSendMessage });
  });

  test('while the spec is written it names the writer and offers the message as typed, which stops the write', async () => {
    show(job());
    await render();

    expect(text()).toContain('Writing a goal spec from your message…');
    expect(text()).toContain('Goal writer: p/m, high effort');
    expect(text()).toContain('Add dark mode');
    expect(findButton('Send message with goal')).toBeNull();
    expect(findButton('Write again')).toBeNull();

    await click('Use my message as the goal');
    expect(calls).toEqual([{ method: 'POST', path: '/api/goals/spec-jobs/job-1/send', body: { kind: 'original', ignoreLimit: false } }]);
  });

  test('a chat that takes no prompts shows no card, so nothing can send the message or take it back', async () => {
    show(job({ status: 'ready', spec: 'Spec' }));
    await render('ses_card', false);

    expect(text()).toBe('');
    expect(document.querySelectorAll('button')).toHaveLength(0);
  });

  test('a written spec can be edited, sent either way, or written again', async () => {
    const written = job({ status: 'ready', spec: '## Objective\nDark mode' });
    show(written);
    respond = () => Response.json({ revision: 2, job: written });
    await render();
    const textarea = document.querySelector('textarea');
    if (!textarea) throw new Error('The written spec is not editable');
    expect(textarea.value).toBe('## Objective\nDark mode');

    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.win.HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '## Objective\nDark mode everywhere');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Send message with goal');
    await click('Send goal as message');
    await click('Write again');

    expect(calls).toEqual([
      { method: 'POST', path: '/api/goals/spec-jobs/job-1/send', body: { kind: 'spec', sendMode: 'with-message', spec: '## Objective\nDark mode everywhere', ignoreLimit: false } },
      { method: 'POST', path: '/api/goals/spec-jobs/job-1/send', body: { kind: 'spec', sendMode: 'goal-as-message', spec: '## Objective\nDark mode everywhere', ignoreLimit: false } },
      // Write again carries the card's choices: here the defaults.
      { method: 'POST', path: '/api/goals/spec-jobs/job-1/redo', body: { writerChoice: null, ignoreLimit: false } },
    ]);
  });

  test('a failed write shows the reason, with redo and the message as typed', async () => {
    const failed = job({ status: 'failed', trigger: 'auto-create', error: 'No small model available', failedStep: 'write' });
    show(failed);
    respond = () => Response.json({ revision: 2, job: failed });
    await render();

    expect(text()).toContain('The goal writer could not write a spec.');
    expect(text()).toContain('No small model available');
    expect(findButton('Send message with goal')).toBeNull();
    await click('Try again');
    await click('Send without a goal');
    expect(calls.map((call) => call.path)).toEqual(['/api/goals/spec-jobs/job-1/redo', '/api/goals/spec-jobs/job-1/send']);
    expect(calls[1]?.body).toEqual({ kind: 'original', ignoreLimit: false });
  });

  test('a send of the message as typed that failed while the spec was written says the send failed', async () => {
    // "Send original" stopped the write, so the job has no spec and reads as failed.
    show(job({ status: 'failed', failedStep: 'send', error: 'OpenCode POST /api/session/ses_card/prompt failed with 500' }));
    await render();

    expect(text()).toContain('The message was not sent.');
    expect(text()).toContain('failed with 500');
    expect(text()).not.toContain('The goal writer could not write a spec.');
  });

  test('Try again after a failed send of the message as typed sends it again and writes no spec', async () => {
    const failed = job({ status: 'failed', failedStep: 'send', error: 'OpenCode is not reachable' });
    show(failed);
    respond = () => Response.json({ revision: 2, job: failed });
    await render();

    await click('Try again');

    expect(calls).toEqual([{ method: 'POST', path: '/api/goals/spec-jobs/job-1/send', body: { kind: 'original', ignoreLimit: false } }]);
  });

  test('back to edit hands the whole message to the session\'s composer and arms the goal again', async () => {
    show(job());
    respond = () => Response.json({
      revision: 2,
      job: job({ status: 'cancelled' }),
      message: {
        content: 'Add dark mode\nto settings',
        text: 'Add dark mode\nto settings',
        attachments: [{ id: 'a1', filename: 'mock.png', mimeType: 'image/png', size: 2, source: 'local', dataUrl: 'data:image/png;base64,aGk=' }],
        context: [{ kind: 'synthetic', text: 'Resolve the conflict' }],
      },
    });
    const listed = spyOn(opencodeClient, 'getSessionMessages');
    await render();
    await click('Back to edit');
    listed.mockRestore();

    const [edit] = useInputStore.getState().pendingComposerEdits;
    expect(edit?.target).toEqual({ kind: 'session', sessionId: 'ses_card' });
    expect(edit?.content).toBe('Add dark mode\nto settings');
    expect(edit?.attachments.map((file) => file.filename)).toEqual(['mock.png']);
    expect(edit?.context).toEqual([{ kind: 'synthetic', text: 'Resolve the conflict' }]);
    expect(useSessionGoalArmStore.getState().armed).toBe(true);
    // A job in a session that was there before never asks whether to remove it.
    expect(listed.mock.calls.length).toBe(0);
    // The job is over: the card goes.
    expect(text()).toBe('');
  });

  describe('back to edit on a new chat, whose session was made for the message', () => {
    const NEW_DRAFT_ID = 77;
    const original = useSessionUIStore.getState();
    let deleted: string[];
    let opened: Array<string | null | undefined>;
    let listed: ReturnType<typeof spyOn<typeof opencodeClient, 'getSessionMessages'>>;
    const page = (items: MessagePage['items']): MessagePage => ({ items, cursor: {} });

    beforeEach(() => {
      deleted = [];
      opened = [];
      listed = spyOn(opencodeClient, 'getSessionMessages').mockResolvedValue(page([]));
      respond = () => Response.json({
        revision: 2,
        job: job({ status: 'cancelled', newSession: true }),
        message: { content: 'Add dark mode', text: 'Add dark mode', attachments: [], context: [] },
      });
      useSessionUIStore.setState({
        currentSessionId: 'ses_card',
        deleteSession: async (id) => {
          deleted.push(id);
          return true;
        },
        openNewSessionDraft: (options) => {
          opened.push(options?.directoryOverride);
          useSessionUIStore.setState({
            currentSessionId: null,
            newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: true, draftId: NEW_DRAFT_ID },
          });
        },
      });
    });

    afterEach(() => {
      listed.mockRestore();
      useSessionUIStore.setState({
        currentSessionId: original.currentSessionId,
        newSessionDraft: original.newSessionDraft,
        deleteSession: original.deleteSession,
        openNewSessionDraft: original.openNewSessionDraft,
      });
    });

    test('with nothing sent in it, the session goes and a new draft gets the message', async () => {
      show(job({ newSession: true }));
      await render();
      await click('Back to edit');

      expect(listed.mock.calls).toEqual([['ses_card', { limit: 1 }, '/repo']]);
      expect(deleted).toEqual(['ses_card']);
      expect(opened).toEqual(['/repo']);
      const [edit] = useInputStore.getState().pendingComposerEdits;
      expect(edit?.target).toEqual({ kind: 'draft', draftId: NEW_DRAFT_ID });
      expect(edit?.content).toBe('Add dark mode');
      expect(useSessionGoalArmStore.getState().armed).toBe(true);
    });

    test('a session with a message stays, and the message goes back to it', async () => {
      listed.mockResolvedValue(page([{ info: { id: 'msg_1', sessionID: 'ses_card', role: 'user', time: { created: 1 } }, parts: [] }]));
      show(job({ newSession: true }));
      await render();
      await click('Back to edit');

      expect(deleted).toEqual([]);
      expect(opened).toEqual([]);
      expect(useInputStore.getState().pendingComposerEdits[0]?.target).toEqual({ kind: 'session', sessionId: 'ses_card' });
    });

    test('when OpenCode cannot say whether anything was sent, the session stays', async () => {
      listed.mockRejectedValue(new Error('OpenCode is not reachable'));
      const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
      show(job({ newSession: true }));
      await render();
      await click('Back to edit');
      warn.mockRestore();

      expect(deleted).toEqual([]);
      expect(opened).toEqual([]);
      expect(useInputStore.getState().pendingComposerEdits[0]?.target).toEqual({ kind: 'session', sessionId: 'ses_card' });
    });

    test('a session that could not be removed keeps the message', async () => {
      useSessionUIStore.setState({ deleteSession: async () => false });
      show(job({ newSession: true }));
      await render();
      await click('Back to edit');

      expect(opened).toEqual([]);
      expect(useInputStore.getState().pendingComposerEdits[0]?.target).toEqual({ kind: 'session', sessionId: 'ses_card' });
    });

    test('a message this window holds for the session keeps it, whatever OpenCode lists', async () => {
      const sdk = OpenCode.make({ baseUrl: 'https://sync.test', fetch: async () => Response.json({ data: [] }) });
      const childStores = new ChildStoreManager();
      childStores.ensureChild('/repo', { bootstrap: false }).setState({
        message: { ses_card: [{ id: 'msg_sending', sessionID: 'ses_card', role: 'user', time: { created: 1 } }] },
      });
      setSyncRefs(sdk, childStores, '/repo');
      try {
        show(job({ newSession: true }));
        await render();
        await click('Back to edit');
      } finally {
        setSyncRefs(sdk, new ChildStoreManager(), '');
      }

      expect(deleted).toEqual([]);
      expect(useInputStore.getState().pendingComposerEdits[0]?.target).toEqual({ kind: 'session', sessionId: 'ses_card' });
    });

    test('a message this window sends while OpenCode is asked keeps the session', async () => {
      const sdk = OpenCode.make({ baseUrl: 'https://sync.test', fetch: async () => Response.json({ data: [] }) });
      const childStores = new ChildStoreManager();
      const child = childStores.ensureChild('/repo', { bootstrap: false });
      setSyncRefs(sdk, childStores, '/repo');
      // OpenCode answers as of before the send: the session still looks empty there.
      listed.mockImplementation(async () => {
        child.setState({ message: { ses_card: [{ id: 'msg_new', sessionID: 'ses_card', role: 'user', time: { created: 2 } }] } });
        return page([]);
      });
      try {
        show(job({ newSession: true }));
        await render();
        await click('Back to edit');
      } finally {
        setSyncRefs(sdk, new ChildStoreManager(), '');
      }

      expect(listed.mock.calls.length).toBe(1);
      expect(deleted).toEqual([]);
      expect(opened).toEqual([]);
      expect(useInputStore.getState().pendingComposerEdits[0]?.target).toEqual({ kind: 'session', sessionId: 'ses_card' });
    });

    test('a switch to another session while OpenCode is asked keeps the session and opens no draft', async () => {
      listed.mockImplementation(async () => {
        useSessionUIStore.setState({ currentSessionId: 'ses_other' });
        return page([]);
      });
      show(job({ newSession: true }));
      await render();
      await click('Back to edit');

      expect(listed.mock.calls.length).toBe(1);
      expect(deleted).toEqual([]);
      expect(opened).toEqual([]);
      expect(useInputStore.getState().pendingComposerEdits[0]?.target).toEqual({ kind: 'session', sessionId: 'ses_card' });
    });

    test('a new chat\'s session in a side column stays; only the one on screen in the main chat makes way', async () => {
      useSessionUIStore.setState({ currentSessionId: 'ses_main' });
      show(job({ newSession: true }));
      await render();
      await click('Back to edit');

      expect(listed.mock.calls.length).toBe(0);
      expect(deleted).toEqual([]);
      expect(useInputStore.getState().pendingComposerEdits[0]?.target).toEqual({ kind: 'session', sessionId: 'ses_card' });
    });
  });

  test('a message with attachments says why it waits and is sent from this window, then settled', async () => {
    const waiting = job({
      status: 'ready',
      spec: 'Spec',
      composerOnly: true,
      message: { content: 'See the mock', text: 'See the mock', attachments: [{ id: 'a1', filename: 'mock.png', mimeType: 'image/png', size: 2 }], contextCount: 1 },
    });
    show(waiting);
    respond = (call) => (call.path.endsWith('/claim')
      ? Response.json({
        revision: 2,
        job: { ...waiting, sending: true, claimId: 'claim-now' },
        message: {
          content: 'See the mock',
          text: 'See the mock',
          attachments: [{ id: 'a1', filename: 'mock.png', mimeType: 'image/png', size: 2, source: 'local', dataUrl: 'data:image/png;base64,aGk=' }],
          context: [{ kind: 'synthetic', text: 'Resolve the conflict' }],
        },
      })
      : Response.json({ revision: 3, job: { ...waiting, status: 'sent', outcome: { kind: 'spec', sendMode: 'with-message' } } }));
    const sent: Array<{ text: string; provider: string; agent: string | undefined; files: string[]; parts: string[]; goalArm: SessionGoalArm | undefined; composerArmed: boolean }> = [];
    const sendMessage: SendMessage = async (content, providerID, _modelID, agent, attachments, _mention, additionalParts, _variant, _mode, options) => {
      options?.onMessageID?.('msg_card_1');
      sent.push({
        text: content,
        provider: providerID,
        agent,
        files: (attachments ?? []).map((file) => file.filename),
        parts: (additionalParts ?? []).map((part) => part.text),
        goalArm: options?.goalArm,
        composerArmed: useSessionGoalArmStore.getState().armed,
      });
    };
    useSessionUIStore.setState({ sendMessage });
    // The user armed a goal for their next composer message.
    useSessionGoalArmStore.getState().setArmed(true, null);
    await render();

    expect(text()).toContain('This message has attachments or attached context, so it waits for you to send it.');
    await click('Send message with goal');

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /api/goals/spec-jobs/job-1/claim',
      'POST /api/goals/spec-jobs/job-1/settle',
    ]);
    expect(calls[0]?.body).toEqual({ kind: 'spec' });
    // The goal goes with the send; the composer's arm is not touched.
    expect(sent).toEqual([{
      text: 'See the mock',
      provider: 'p',
      agent: 'build',
      files: ['mock.png'],
      parts: ['Resolve the conflict'],
      goalArm: { armed: true, objectiveOverride: 'Spec', settled: true, briefAgent: true, ignoreLimit: false },
      composerArmed: true,
    }]);
    // The settle names the user message the send created, and the claim it was sent under.
    expect(calls[1]?.body).toEqual({ outcome: { kind: 'spec', sendMode: 'with-message' }, spec: 'Spec', messageId: 'msg_card_1', claimId: 'claim-now' });
    expect(useSessionGoalArmStore.getState()).toMatchObject({ armed: true, objectiveOverride: null });
    expect(text()).toContain('Sent your message as typed. The spec is its goal.');
  });

  test('a send from this window goes to the directory the claim found the job in, where its session moved', async () => {
    const ready = job({ status: 'ready', spec: 'Spec', composerOnly: true });
    show(ready);
    respond = (call) => (call.path.endsWith('/claim')
      ? Response.json({
        revision: 2,
        job: { ...ready, directory: '/repo-moved', sending: true, claimId: 'claim-now' },
        message: { content: 'x', text: 'x', attachments: [], context: [{ kind: 'synthetic', text: 'Resolve the conflict' }] },
      })
      : Response.json({ revision: 3, job: { ...ready, directory: '/repo-moved', status: 'sent', outcome: { kind: 'spec', sendMode: 'with-message' } } }));
    const targets: Array<string | undefined> = [];
    const sendMessage: SendMessage = async (_content, _providerID, _modelID, _agent, _attachments, _mention, _parts, _variant, _mode, options) => {
      targets.push(options?.target?.directory);
    };
    useSessionUIStore.setState({ sendMessage });

    await sendGoalSpecJob(ready, { kind: 'spec', sendMode: 'with-message', spec: 'Spec' });

    expect(targets).toEqual(['/repo-moved']);
  });

  test('a send from this window that fails is settled with the reason', async () => {
    const waiting = job({ status: 'ready', spec: 'Spec', composerOnly: true });
    show(waiting);
    respond = (call) => (call.path.endsWith('/claim')
      ? Response.json({ revision: 2, job: { ...waiting, sending: true, claimId: 'claim-now' }, message: { content: 'x', text: 'x', attachments: [], context: [{ kind: 'synthetic', text: 'Resolve the conflict' }] } })
      : Response.json({ revision: 3, job: { ...waiting, error: 'OpenCode is not reachable', failedStep: 'send' } }));
    const sendMessage: SendMessage = async () => {
      throw new Error('OpenCode is not reachable');
    };
    useSessionUIStore.setState({ sendMessage });
    await render();
    await click('Send message with goal');

    expect(calls[1]).toEqual({
      method: 'POST',
      path: '/api/goals/spec-jobs/job-1/settle',
      body: { outcome: null, error: 'OpenCode is not reachable', claimId: 'claim-now' },
    });
    expect(text()).toContain('The message was not sent.');
  });

  test('a send waiting for the agent to finish its turn says so, and only Back to edit changes it', async () => {
    // An earlier failed send is over once the message waits to go out again.
    show(job({ status: 'ready', spec: 'Spec', waiting: true, error: 'OpenCode is not reachable', failedStep: 'send' }));
    respond = () => Response.json({
      revision: 2,
      job: job({ status: 'cancelled' }),
      message: { content: 'Add dark mode\nto settings', text: 'Add dark mode\nto settings', attachments: [], context: [] },
    });
    await render();

    expect(text()).toContain('Queued. It is sent when the agent finishes its turn.');
    expect(text()).not.toContain('OpenCode is not reachable');
    for (const label of ['Send message with goal', 'Send goal as message', 'Use my message as the goal', 'Write again']) {
      expect(`${label}: ${findButton(label)?.disabled}`).toBe(`${label}: true`);
    }
    expect(document.querySelector('textarea')?.disabled).toBe(true);

    await click('Back to edit');
    expect(calls).toEqual([{ method: 'POST', path: '/api/goals/spec-jobs/job-1/edit', body: undefined }]);
  });

  test('a message with attachments sent while the agent works waits on the card, then goes out from this window once it is handed over', async () => {
    const ready = job({
      status: 'ready',
      spec: 'Spec',
      composerOnly: true,
      message: { content: 'See the mock', text: 'See the mock', attachments: [{ id: 'a1', filename: 'mock.png', mimeType: 'image/png', size: 2 }], contextCount: 0 },
    });
    show(ready);
    respond = (call) => (call.path.endsWith('/claim')
      ? Response.json({
        revision: 2,
        job: { ...ready, waiting: true, claimId: 'claim-1' },
        message: {
          content: 'See the mock',
          text: 'See the mock',
          attachments: [{ id: 'a1', filename: 'mock.png', mimeType: 'image/png', size: 2, source: 'local', dataUrl: 'data:image/png;base64,aGk=' }],
          context: [],
        },
      })
      : Response.json({ revision: 4, job: { ...ready, status: 'sent', outcome: { kind: 'spec', sendMode: 'with-message' } } }));
    const sent: Array<{ text: string; files: string[]; goalArm: SessionGoalArm | undefined }> = [];
    const sendMessage: SendMessage = async (content, _providerID, _modelID, _agent, attachments, _mention, _parts, _variant, _mode, options) => {
      sent.push({ text: content, files: (attachments ?? []).map((file) => file.filename), goalArm: options?.goalArm });
    };
    useSessionUIStore.setState({ sendMessage });
    await render();
    await click('Send message with goal');

    // Queued: nothing went out, and only Back to edit changes it.
    expect(calls.map((call) => call.path)).toEqual(['/api/goals/spec-jobs/job-1/claim']);
    expect(sent).toEqual([]);
    expect(text()).toContain('Queued. It is sent when the agent finishes its turn.');
    expect(text()).not.toContain('so it waits for you to send it');
    expect(findButton('Back to edit')?.disabled).toBe(false);
    expect(findButton('Send message with goal')?.disabled).toBe(true);

    // The turn is over and the server hands the claim to this window. The
    // same hand-over read twice (its event, then a resync) sends once.
    const handedOver = { ...ready, sending: true, claimId: 'claim-1' };
    await act(async () => {
      useGoalSpecJobStore.getState().applyServerJob('ses_card', handedOver, 3, getRuntimeKey());
      useGoalSpecJobStore.getState().applyServerJob('ses_card', handedOver, 3, getRuntimeKey());
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(sent).toEqual([{ text: 'See the mock', files: ['mock.png'], goalArm: { armed: true, objectiveOverride: 'Spec', settled: true, briefAgent: true, ignoreLimit: false } }]);
    expect(calls.map((call) => call.path)).toEqual(['/api/goals/spec-jobs/job-1/claim', '/api/goals/spec-jobs/job-1/settle']);
    expect(calls[1]?.body).toEqual({ outcome: { kind: 'spec', sendMode: 'with-message' }, spec: 'Spec', claimId: 'claim-1' });
    expect(text()).toContain('Sent your message as typed. The spec is its goal.');
  });

  test('a queued message is not sent from this window once its job names another claim', async () => {
    // This window missed its hand-over and the claim expired; another window
    // claimed the job since, and that window sends it.
    const ready = job({ status: 'ready', spec: 'Spec', composerOnly: true });
    show(ready);
    respond = () => Response.json({
      revision: 2,
      job: { ...ready, waiting: true, claimId: 'claim-1' },
      message: { content: 'x', text: 'x', attachments: [], context: [{ kind: 'synthetic', text: 'Resolve the conflict' }] },
    });
    const sent: string[] = [];
    const sendMessage: SendMessage = async (content) => {
      sent.push(content);
    };
    useSessionUIStore.setState({ sendMessage });
    await render();
    await click('Send message with goal');

    await act(async () => {
      useGoalSpecJobStore.getState().applyServerJob('ses_card', { ...ready, sending: true, claimId: 'claim-2' }, 6, getRuntimeKey());
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(sent).toEqual([]);
    expect(calls.map((call) => call.path)).toEqual(['/api/goals/spec-jobs/job-1/claim']);
  });

  // `runtimeFetch` and the send path reach only the active runtime, so a
  // claim must never be sent or reported after the user switched away from
  // the server that holds it; that server releases the claim when it expires.
  describe('after a switch to another runtime', () => {
    const originalBase = getRuntimeApiBaseUrl();
    const originalRuntime = getRuntimeKey();
    const switchAway = () => switchRuntimeEndpoint({ apiBaseUrl: 'http://other-goal-card.test', runtimeKey: 'goal-card-other' });
    const ready = job({ status: 'ready', spec: 'Spec', composerOnly: true });
    const specChoice = { kind: 'spec', sendMode: 'with-message', spec: 'Spec' } as const;
    const claimAnswer = () => Response.json({
      revision: 2,
      job: { ...ready, sending: true, claimId: 'claim-now' },
      message: { content: 'x', text: 'x', attachments: [], context: [{ kind: 'synthetic', text: 'Resolve the conflict' }] },
    });

    afterEach(() => {
      if (getRuntimeKey() !== originalRuntime) switchRuntimeEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalRuntime });
    });

    test('a claim answered after the switch is not sent on the new runtime', async () => {
      show(ready);
      respond = (call) => {
        if (!call.path.endsWith('/claim')) return Response.json({ revision: 3, job: null });
        // The user switches while the claim is on its way back.
        switchAway();
        return claimAnswer();
      };
      const sent: string[] = [];
      const sendMessage: SendMessage = async (content) => {
        sent.push(content);
      };
      useSessionUIStore.setState({ sendMessage });

      await expect(sendGoalSpecJob(ready, specChoice)).rejects.toThrow('the runtime changed');

      expect(sent).toEqual([]);
      expect(calls.map((call) => call.path)).toEqual(['/api/goals/spec-jobs/job-1/claim']);
    });

    for (const outcome of ['goes out', 'fails'] as const) {
      test(`a send that ${outcome} after the switch reports nothing to the new runtime`, async () => {
        show(ready);
        respond = (call) => (call.path.endsWith('/claim') ? claimAnswer() : Response.json({ revision: 3, job: null }));
        const sendMessage: SendMessage = async () => {
          switchAway();
          if (outcome === 'fails') throw new Error('OpenCode is not reachable');
        };
        useSessionUIStore.setState({ sendMessage });

        const sending = sendGoalSpecJob(ready, specChoice);
        if (outcome === 'fails') await expect(sending).rejects.toThrow('OpenCode is not reachable');
        else await sending;

        expect(calls.map((call) => call.path)).toEqual(['/api/goals/spec-jobs/job-1/claim']);
      });
    }

    test('Back to edit answered after the switch gives the message to the old runtime\'s composer and arms nothing on the new one', async () => {
      const armed = job({ status: 'ready', spec: 'Spec', trigger: 'armed' });
      show(armed);
      const editRuntime = getRuntimeKey();
      respond = () => {
        switchAway();
        return Response.json({
          revision: 2,
          job: { ...armed, status: 'cancelled' },
          message: { content: 'Add dark mode', text: 'Add dark mode', attachments: [], context: [] },
        });
      };

      await takeGoalSpecJobBack(armed);

      expect(useInputStore.getState().pendingComposerEdits.map((edit) => edit.runtimeKey)).toEqual([editRuntime]);
      expect(useSessionGoalArmStore.getState().armed).toBe(false);
    });
  });

  test('a sent job says how it went and can be dismissed', async () => {
    show(job({ status: 'sent', trigger: 'auto-create', outcome: { kind: 'original', withGoal: false } }));
    await render();

    expect(text()).toContain('Sent your message as typed, without a goal.');
    await click('Dismiss');
    expect(calls).toEqual([{ method: 'DELETE', path: '/api/goals/spec-jobs/job-1', body: undefined }]);
  });

  test('the sent line wraps on a narrow screen, so the whole sentence shows', async () => {
    show(job({ status: 'sent', outcome: { kind: 'spec', sendMode: 'with-message' } }));
    await render();

    const line = Array.from(document.querySelectorAll('span')).find((element) => (
      element.textContent === 'Sent your message as typed. The spec is its goal.'
    ));
    if (!line) throw new Error(`No sent line in: ${text()}`);
    // happy-dom lays nothing out, so the classes are what can be checked here.
    const classes = Array.from(line.classList);
    expect(classes.includes('truncate')).toBe(false);
    expect(classes.includes('break-words')).toBe(true);
  });

  test('a sent job whose goal reminder failed still says it was sent, and shows what failed', async () => {
    show(job({ status: 'sent', outcome: { kind: 'spec', sendMode: 'with-message' }, warning: 'the goal reminder was not sent: HTTP 500' }));
    await render();

    expect(text()).toContain('Sent your message as typed. The spec is its goal.');
    expect(text()).toContain('The message went out, but a step of the send failed: the goal reminder was not sent: HTTP 500');
  });

  test('switching to another session and back cancels nothing', async () => {
    show(job({ status: 'ready', spec: 'Spec' }));
    await render();
    await render('ses_other');
    expect(text()).toBe('');
    await render();

    expect(calls).toEqual([]);
    expect(text()).toContain('Send message with goal');
  });
});
