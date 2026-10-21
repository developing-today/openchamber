import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGoalSpecJobStore, type GoalSpecJob } from '@/stores/goalSpecJobStore';
import { useSessionGoalArmStore, type SessionGoalArm } from '@/stores/useSessionGoalArmStore';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { GoalSpecJobCard } from './GoalSpecJobCard';

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

  const render = (sessionId = 'ses_card') => act(async () => root.render(
    <I18nProvider>
      <GoalSpecJobCard sessionId={sessionId} />
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
    expect(calls).toEqual([{ method: 'POST', path: '/api/goals/spec-jobs/job-1/send', body: { kind: 'original' } }]);
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
      { method: 'POST', path: '/api/goals/spec-jobs/job-1/send', body: { kind: 'spec', sendMode: 'with-message', spec: '## Objective\nDark mode everywhere' } },
      { method: 'POST', path: '/api/goals/spec-jobs/job-1/send', body: { kind: 'spec', sendMode: 'goal-as-message', spec: '## Objective\nDark mode everywhere' } },
      { method: 'POST', path: '/api/goals/spec-jobs/job-1/redo', body: undefined },
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
    expect(calls[1]?.body).toEqual({ kind: 'original' });
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

    expect(calls).toEqual([{ method: 'POST', path: '/api/goals/spec-jobs/job-1/send', body: { kind: 'original' } }]);
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
    await render();
    await click('Back to edit');

    const [edit] = useInputStore.getState().pendingComposerEdits;
    expect(edit?.sessionId).toBe('ses_card');
    expect(edit?.content).toBe('Add dark mode\nto settings');
    expect(edit?.attachments.map((file) => file.filename)).toEqual(['mock.png']);
    expect(edit?.context).toEqual([{ kind: 'synthetic', text: 'Resolve the conflict' }]);
    expect(useSessionGoalArmStore.getState().armed).toBe(true);
    // The job is over: the card goes.
    expect(text()).toBe('');
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
        job: { ...waiting, sending: true },
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
      goalArm: { armed: true, objectiveOverride: 'Spec', settled: true, briefAgent: true },
      composerArmed: true,
    }]);
    // The settle names the user message the send created.
    expect(calls[1]?.body).toEqual({ outcome: { kind: 'spec', sendMode: 'with-message' }, spec: 'Spec', messageId: 'msg_card_1' });
    expect(useSessionGoalArmStore.getState()).toMatchObject({ armed: true, objectiveOverride: null });
    expect(text()).toContain('Sent your message as typed. The spec is its goal.');
  });

  test('a send from this window that fails is settled with the reason', async () => {
    const waiting = job({ status: 'ready', spec: 'Spec', composerOnly: true });
    show(waiting);
    respond = (call) => (call.path.endsWith('/claim')
      ? Response.json({ revision: 2, job: { ...waiting, sending: true }, message: { content: 'x', text: 'x', attachments: [], context: [{ kind: 'synthetic', text: 'Resolve the conflict' }] } })
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
      body: { outcome: null, error: 'OpenCode is not reachable' },
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

    expect(sent).toEqual([{ text: 'See the mock', files: ['mock.png'], goalArm: { armed: true, objectiveOverride: 'Spec', settled: true, briefAgent: true } }]);
    expect(calls.map((call) => call.path)).toEqual(['/api/goals/spec-jobs/job-1/claim', '/api/goals/spec-jobs/job-1/settle']);
    expect(calls[1]?.body).toEqual({ outcome: { kind: 'spec', sendMode: 'with-message' }, spec: 'Spec' });
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
