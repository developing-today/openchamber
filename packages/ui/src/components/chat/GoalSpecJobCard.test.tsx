import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGoalSpecJobStore, type GoalSpecJob } from '@/stores/goalSpecJobStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
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
    const failed = job({ status: 'failed', trigger: 'auto-create', error: 'No small model available' });
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
    const sent: Array<{ text: string; provider: string; agent: string | undefined; files: string[]; parts: string[]; arm: { armed: boolean; objectiveOverride: string | null; briefAgent: boolean } }> = [];
    const sendMessage: SendMessage = async (content, providerID, _modelID, agent, attachments, _mention, additionalParts) => {
      const arm = useSessionGoalArmStore.getState();
      sent.push({
        text: content,
        provider: providerID,
        agent,
        files: (attachments ?? []).map((file) => file.filename),
        parts: (additionalParts ?? []).map((part) => part.text),
        arm: { armed: arm.armed, objectiveOverride: arm.objectiveOverride, briefAgent: arm.briefAgent },
      });
    };
    useSessionUIStore.setState({ sendMessage });
    await render();

    expect(text()).toContain('This message has attachments or attached context, so it waits for you to send it.');
    await click('Send message with goal');

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /api/goals/spec-jobs/job-1/claim',
      'POST /api/goals/spec-jobs/job-1/settle',
    ]);
    expect(calls[0]?.body).toEqual({ kind: 'spec' });
    expect(sent).toEqual([{
      text: 'See the mock',
      provider: 'p',
      agent: 'build',
      files: ['mock.png'],
      parts: ['Resolve the conflict'],
      arm: { armed: true, objectiveOverride: 'Spec', briefAgent: true },
    }]);
    expect(calls[1]?.body).toEqual({ outcome: { kind: 'spec', sendMode: 'with-message' }, spec: 'Spec' });
    // What the user had armed for their next message is theirs again.
    expect(useSessionGoalArmStore.getState().armed).toBe(false);
    expect(text()).toContain('Sent your message as typed. The spec is its goal.');
  });

  test('a send from this window that fails is settled with the reason', async () => {
    const waiting = job({ status: 'ready', spec: 'Spec', composerOnly: true });
    show(waiting);
    respond = (call) => (call.path.endsWith('/claim')
      ? Response.json({ revision: 2, job: { ...waiting, sending: true }, message: { content: 'x', text: 'x', attachments: [], context: [{ kind: 'synthetic', text: 'Resolve the conflict' }] } })
      : Response.json({ revision: 3, job: { ...waiting, error: 'OpenCode is not reachable' } }));
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

  test('a sent job says how it went and can be dismissed', async () => {
    show(job({ status: 'sent', trigger: 'auto-create', outcome: { kind: 'original', withGoal: false } }));
    await render();

    expect(text()).toContain('Sent your message as typed, without a goal.');
    await click('Dismiss');
    expect(calls).toEqual([{ method: 'DELETE', path: '/api/goals/spec-jobs/job-1', body: undefined }]);
  });

  test('a sent job with a failed later step still says it was sent, and shows what failed', async () => {
    show(job({ status: 'sent', outcome: { kind: 'spec', sendMode: 'with-message' }, warning: 'the goal reminder could not be sent: HTTP 500' }));
    await render();

    expect(text()).toContain('Sent your message as typed. The spec is its goal.');
    expect(text()).toContain('the goal reminder could not be sent: HTTP 500');
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
