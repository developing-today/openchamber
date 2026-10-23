import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { DesktopSettings } from '@/lib/desktop';
import type { GoalSpecJob } from '@/stores/goalSpecJobStore';
import type { SessionGoalArm } from '@/stores/useSessionGoalArmStore';

// The writer and the length limit for one spec, chosen on the goal writer card
// as #150's goal writer dialog offered them. They go with Write again and with
// a send. Base UI and react-dom read the window when their modules load, so
// the DOM is installed before anything that renders is imported.

const DOM_GLOBAL_NAMES = [
  'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'Event', 'KeyboardEvent',
  'MouseEvent', 'PointerEvent', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'localStorage', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
] as const;

const win = new Window({ url: 'http://localhost' });
const previousGlobals = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
const domValues = {
  window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
  HTMLElement: win.HTMLElement, HTMLTextAreaElement: win.HTMLTextAreaElement, Event: win.Event,
  KeyboardEvent: win.KeyboardEvent, MouseEvent: win.MouseEvent, PointerEvent: win.PointerEvent,
  MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver, IntersectionObserver: win.IntersectionObserver,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win), requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
};
for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: domValues[name], configurable: true, writable: true });

type Call = { method: string; path: string; body: ReturnType<typeof JSON.parse> };

let calls: Call[] = [];
let respond: (call: Call) => Response = () => Response.json({ revision: 2, job: null });
// The server's settings for the whole file, as the settings module remembers
// what it wrote across tests: a read answers what was written.
const serverSettings: DesktopSettings = {};
const originalFetch = globalThis.fetch;
// Installed before anything is imported: the stores ask the server for the
// home directory and Settings as they load, and none of it may reach the
// network. The writer picker reads Settings and the small model, and saves a
// remembered pick in Settings; the job's own requests are the calls.
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const body = await request.text();
  const call: Call = { method: request.method, path: new URL(request.url).pathname, body: body ? JSON.parse(body) : undefined };
  if (call.path === '/api/config/settings') {
    if (call.method === 'PUT') Object.assign(serverSettings, call.body);
    return Response.json(serverSettings);
  }
  if (!call.path.startsWith('/api/goals/spec-jobs')) return Response.json({});
  calls.push(call);
  return respond(call);
}, originalFetch);

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { configureRuntimeUrlResolver } = await import('@/lib/runtime-url');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { useGoalSpecJobStore } = await import('@/stores/goalSpecJobStore');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { ensureHomeDirectoryResolved } = await import('@/stores/useDirectoryStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { ChatColumnTakesPromptsContext } = await import('./chatColumnSession');
const { GoalSpecJobCard } = await import('./GoalSpecJobCard');

afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  void win.happyDOM.close();
});

type SendMessage = ReturnType<typeof useSessionUIStore.getState>['sendMessage'];

const PICKED = { providerID: 'p', modelID: 'm', variant: 'low' };

const job = (overrides: Partial<GoalSpecJob> = {}): GoalSpecJob => ({
  id: 'job-1',
  sessionId: 'ses_card',
  directory: '/repo',
  status: 'ready',
  trigger: 'armed',
  review: true,
  sendMode: 'with-message',
  tokenBudget: null,
  message: { content: 'Add dark mode', text: 'Add dark mode', attachments: [], contextCount: 0 },
  composerOnly: false,
  spec: 'Spec',
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

// The session's model, p/m, has two effort levels.
const model = {
  id: 'm',
  modelID: 'm',
  providerID: 'p',
  name: 'M',
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [{ id: 'low' }, { id: 'high' }],
  time: { released: 0 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: 'active' as const,
  enabled: true,
  limit: { context: 0, output: 0 },
};

const originalSendMessage = useSessionUIStore.getState().sendMessage;
const originalConfig = useConfigStore.getState();
const originalUi = useUIStore.getState();

describe('GoalSpecJobCard choices for this spec', () => {
  let root: Root;
  let container: HTMLElement;

  const show = (value: GoalSpecJob) => useGoalSpecJobStore.getState().applyServerJob(value.sessionId, value, 1, getRuntimeKey());
  const render = () => act(async () => root.render(
    <I18nProvider>
      <ChatColumnTakesPromptsContext.Provider value>
        <GoalSpecJobCard sessionId="ses_card" />
      </ChatColumnTakesPromptsContext.Provider>
    </I18nProvider>,
  ));
  const text = () => document.body.textContent ?? '';
  const findButton = (label: string): HTMLButtonElement | null => (
    Array.from(document.querySelectorAll('button')).find((element) => (
      element.textContent?.trim() === label || element.getAttribute('aria-label') === label
    )) ?? null
  );
  const click = async (label: string) => {
    const button = findButton(label);
    if (!button) throw new Error(`No button "${label}" in: ${text()}`);
    await act(async () => { button.click(); });
    // The action's request and the answer it applies.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const fire = (target: Element, type: string) => {
    const init = { bubbles: true, cancelable: true, button: 0 };
    target.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse' }) : new MouseEvent(type, init));
  };
  /** Picks an effort in the writer row as a person does: a press opens it, a hover highlights the option, a press picks it. */
  const pickEffort = async (option: string) => {
    const trigger = document.querySelector<HTMLElement>('[role="combobox"][aria-label="Goal writer effort"]');
    if (!trigger) throw new Error(`No effort picker in: ${text()}`);
    await act(async () => {
      fire(trigger, 'pointerdown');
      fire(trigger, 'mousedown');
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) => element.textContent?.trim() === option);
    if (!item) throw new Error(`No effort "${option}"`);
    await act(async () => {
      for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) fire(item, type);
    });
    await act(async () => {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) fire(item, type);
    });
  };
  /** Switches this spec's length limit in the card's menu. */
  const toggleLimit = async () => {
    const trigger = findButton('More goal options');
    if (!trigger) throw new Error(`No goal options in: ${text()}`);
    await act(async () => { trigger.click(); });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes('No length limit for this goal'));
    if (!item) throw new Error('No length limit switch in the menu');
    await act(async () => { item.click(); });
  };
  // A pick saved in Settings goes out after the settings write's short debounce.
  const settingsSettled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });

  // The directory store resolves the home directory as it loads, and the
  // config store then makes the home the active directory with its own (empty)
  // catalog. Settled first, so it cannot replace a test's catalog midway.
  beforeAll(async () => {
    await ensureHomeDirectoryResolved();
  });

  beforeEach(() => {
    calls = [];
    respond = () => Response.json({ revision: 2, job: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    configureRuntimeUrlResolver({ apiBaseUrl: 'http://goal-card.test' });
    useGoalSpecJobStore.getState().resetForRuntimeSwitch();
    useConfigStore.setState({
      providers: [{ id: 'p', name: 'P', activation: 'enabled', package: 'p', models: [model] }],
      activeDirectoryKey: '/repo',
      loadProviders: async () => undefined,
    });
    useUIStore.setState({ sessionGoalWriterRememberChoice: false, sessionGoalObjectiveCharLimit: 5_000 });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    configureRuntimeUrlResolver({ apiBaseUrl: '' });
    useSessionUIStore.setState({ sendMessage: originalSendMessage });
    useConfigStore.setState({
      providers: originalConfig.providers,
      activeDirectoryKey: originalConfig.activeDirectoryKey,
      loadProviders: originalConfig.loadProviders,
    });
    useUIStore.setState({
      sessionGoalWriterRememberChoice: originalUi.sessionGoalWriterRememberChoice,
      sessionGoalObjectiveCharLimit: originalUi.sessionGoalObjectiveCharLimit,
    });
  });

  test('Write again goes with the writer and effort picked on the card and its length limit, and the card names that writer', async () => {
    const written = job();
    show(written);
    respond = () => Response.json({
      revision: 2,
      job: { ...written, status: 'writing', spec: null, attempt: 2, writer: { source: 'picked', ...PICKED }, writerChoice: PICKED, ignoreLimit: true },
    });
    await render();

    await pickEffort('Low');
    await toggleLimit();
    await click('Write again');

    expect(calls).toEqual([{ method: 'POST', path: '/api/goals/spec-jobs/job-1/redo', body: { writerChoice: PICKED, ignoreLimit: true } }]);
    expect(text()).toContain('Goal writer: p/m, low effort');
  });

  test('a send carries the length limit switched off on the card', async () => {
    show(job());
    await render();

    await toggleLimit();
    await click('Send message with goal');

    expect(calls).toEqual([{ method: 'POST', path: '/api/goals/spec-jobs/job-1/send', body: { kind: 'spec', sendMode: 'with-message', spec: 'Spec', ignoreLimit: true } }]);
  });

  test('a message sent from this window carries the switch on its goal', async () => {
    const waiting = job({
      composerOnly: true,
      message: { content: 'See the mock', text: 'See the mock', attachments: [{ id: 'a1', filename: 'mock.png', mimeType: 'image/png', size: 2 }], contextCount: 0 },
    });
    show(waiting);
    respond = (call) => (call.path.endsWith('/claim')
      ? Response.json({
        revision: 2,
        job: { ...waiting, sending: true },
        message: { content: 'See the mock', text: 'See the mock', attachments: [{ id: 'a1', filename: 'mock.png', mimeType: 'image/png', size: 2, source: 'local', dataUrl: 'data:image/png;base64,aGk=' }], context: [] },
      })
      : Response.json({ revision: 3, job: { ...waiting, status: 'sent', outcome: { kind: 'spec', sendMode: 'with-message' } } }));
    const goals: Array<SessionGoalArm | undefined> = [];
    const sendMessage: SendMessage = async (_content, _provider, _model, _agent, _attachments, _mention, _parts, _variant, _mode, options) => {
      goals.push(options?.goalArm);
    };
    useSessionUIStore.setState({ sendMessage });
    await render();

    await toggleLimit();
    await click('Send message with goal');

    expect(goals).toEqual([{ armed: true, objectiveOverride: 'Spec', settled: true, briefAgent: true, ignoreLimit: true }]);
  });

  test('a spec over the limit shows a warning on its field, and none once the limit is off', async () => {
    useUIStore.setState({ sessionGoalObjectiveCharLimit: 1_000 });
    const written = job({ spec: 'x'.repeat(999) });
    show(written);
    await render();
    const counter = () => document.querySelector('[aria-label="Goal objective length limit"]');

    // The field takes any length: the limit warns, it does not cut.
    expect(document.querySelector('textarea')?.hasAttribute('maxlength')).toBe(false);
    expect(text()).not.toContain('Over the 1000-character limit');
    expect(counter()?.textContent).toBe('999/1000');
    expect(counter()?.className).not.toContain('text-status-warning');

    await act(async () => { useGoalSpecJobStore.getState().setSpecEdit(written, 'x'.repeat(1_001)); });
    expect(text()).toContain('Over the 1000-character limit, so saving condenses it.');
    expect(counter()?.className).toContain('text-status-warning');

    await toggleLimit();
    expect(text()).not.toContain('Over the 1000-character limit');
    expect(text()).toContain('No length limit: the goal is saved whole');
    expect(counter()?.textContent).toBe('1001');
    expect(counter()?.className).not.toContain('text-status-warning');
  });

  test('a writer picked on the card becomes the Settings default when Settings say to remember every pick', async () => {
    useUIStore.setState({ sessionGoalWriterRememberChoice: true });
    show(job());
    await render();

    await pickEffort('Low');
    await settingsSettled();

    expect(serverSettings).toMatchObject({ sessionGoalWriterModel: 'p/m', sessionGoalWriterVariant: 'low' });
    expect(findButton('Remember')).toBeNull();
  });

  test('otherwise a pick stays with this spec until Remember saves it', async () => {
    show(job());
    await render();

    // Another level than any test here saved before.
    await pickEffort('High');
    await settingsSettled();
    expect(serverSettings.sessionGoalWriterVariant).not.toBe('high');

    await click('Remember');
    await settingsSettled();
    expect(serverSettings).toMatchObject({ sessionGoalWriterModel: 'p/m', sessionGoalWriterVariant: 'high' });
  });

  // While the job is being sent or waits for the agent's turn, a pick would
  // name a writer that did not write this spec, and with every pick remembered
  // it would also become the Settings default.
  test('the writer model menu closes and stays shut while the job waits for the turn, and does not reopen by itself', async () => {
    useConfigStore.setState({ providersLoaded: true });
    // A boolean, never the element: a failing match on a happy-dom element
    // prints the whole window graph, and the run never ends.
    const modelMenuOpen = () => document.querySelector('[role="listbox"][aria-label="Models"]') !== null;
    const openWriterModels = async () => {
      const trigger = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-trigger"]'))
        .find((element) => element.textContent?.trim() === 'M');
      if (!trigger) throw new Error(`No writer model trigger in: ${text()}`);
      await act(async () => { trigger.click(); });
    };
    try {
      const written = job();
      show(written);
      await render();
      await openWriterModels();
      expect(modelMenuOpen()).toBe(true);

      await act(async () => { show({ ...written, waiting: true, updatedAt: 2 }); });
      expect(modelMenuOpen()).toBe(false);
      await openWriterModels();
      expect(modelMenuOpen()).toBe(false);

      // Open again, the job does not bring back the menu it closed.
      await act(async () => { show({ ...written, updatedAt: 3 }); });
      expect(modelMenuOpen()).toBe(false);
    } finally {
      useConfigStore.setState({ providersLoaded: originalConfig.providersLoaded });
    }
  });
});
