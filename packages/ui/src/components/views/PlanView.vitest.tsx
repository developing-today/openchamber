import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { EditorView } from '@codemirror/view';
import { z } from 'zod';

test('an open plan takes agent saves and file edits while clean and keeps unsaved typing over them', async () => {
  const dom = new Window({ url: 'http://runtime.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    Document: dom.Document, Text: dom.Text, Range: dom.Range,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const previousFetch = globalThis.fetch;
  let stored = '# Plan A\n\nOriginal';
  const link = { id: 'A', file: 'A.md', title: 'Plan A', createdAt: 1, pinned: false };
  const writes: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://runtime.test');
    if (url.pathname === '/api/fs/home') return Response.json({ home: '/fixture' });
    if (url.pathname === '/api/config/settings') return Response.json({});
    if (url.pathname.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.pathname.endsWith('/plans/A')) {
      if (init?.method === 'PUT') {
        const { raw } = z.object({ raw: z.string() }).parse(JSON.parse(String(init.body)));
        writes.push(raw);
        stored = raw;
        return Response.json({ plan: link, raw });
      }
      return Response.json({ ...link, raw: stored, body: stored, path: null });
    }
    if (url.pathname.startsWith('/api/project-context/')) return Response.json({ notes: [], todos: [], plans: [link], sharedPlansDir: null });
    return Response.json({ error: 'Unavailable in fixture' }, { status: 503 });
  }, previousFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { opencodeClient } = await import('@/lib/opencode/client');
  const { useProjectContextStore } = await import('@/stores/useProjectContextStore');
  const { PlanView } = await import('./PlanView');
  const projectRef = { id: 'plan-fixture', path: '/plan-fixture' };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const apis = createWebAPIs();
  const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const editor = () => {
    const element = host.querySelector('.cm-editor');
    if (!(element instanceof HTMLElement)) throw new Error(`Editor missing: ${host.textContent}`);
    const view = EditorView.findFromDOM(element);
    if (!view) throw new Error('Editor view missing');
    return view;
  };
  // The observer refreshes on focus as it does on a change announcement.
  const agentWrites = async (raw: string) => {
    stored = raw;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await wait(30);
  };
  try {
    useProjectContextStore.getState().reset();
    await act(async () => root.render(<I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={apis}>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory="/plan-fixture">
        <PlanView savedProjectPlan={{ projectRef, planId: 'A' }} />
      </SyncProvider>
    </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider>));
    await wait(30);
    expect(editor().state.doc.toString()).toBe('# Plan A\n\nOriginal');

    await agentWrites('# Plan A\n\nAgent edit');
    expect(editor().state.doc.toString()).toBe('# Plan A\n\nAgent edit');
    // A file edit sends no announcement; the open plan finds it by checking.
    stored = '# Plan A\n\n- [x] Agent edit';
    await wait(2200);
    expect(editor().state.doc.toString()).toBe('# Plan A\n\n- [x] Agent edit');
    await agentWrites('# Plan A\n\nAgent edit');
    // Opening and adopting are reads; neither writes the text back.
    await wait(450);
    expect(writes).toEqual([]);

    await act(async () => editor().dispatch({ changes: { from: editor().state.doc.length, insert: '\nMine' } }));
    await agentWrites('# Plan A\n\nSecond agent edit');
    expect(editor().state.doc.toString()).toBe('# Plan A\n\nAgent edit\nMine');
    await wait(450);
    expect(writes).toEqual(['# Plan A\n\nAgent edit\nMine']);
    expect(stored).toBe('# Plan A\n\nAgent edit\nMine');
  } finally {
    await act(async () => root.unmount());
    useProjectContextStore.getState().reset();
    globalThis.fetch = previousFetch;
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

// "Run as goal" used to put the plan's goal on the composer's shared arm right
// before its send: a composer send made before it took the goal, and the
// goal the user had armed in the composer was replaced.
test('Run as goal sends the plan with its goal and leaves the goal armed in the composer', async () => {
  const dom = new Window({ url: 'http://runtime.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    Document: dom.Document, Text: dom.Text, Range: dom.Range,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const previousFetch = globalThis.fetch;
  const plan = '# Plan A\n\n- [ ] Ship dark mode';
  const link = { id: 'A', file: 'A.md', title: 'Plan A', createdAt: 1, pinned: false };
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://runtime.test');
    if (url.pathname === '/api/fs/home') return Response.json({ home: '/fixture' });
    if (url.pathname === '/api/config/settings') return Response.json({});
    if (url.pathname.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.pathname.endsWith('/plans/A')) return Response.json({ ...link, raw: plan, body: plan, path: null });
    if (url.pathname.startsWith('/api/project-context/')) return Response.json({ notes: [], todos: [], plans: [link], sharedPlansDir: null });
    return Response.json({ error: 'Unavailable in fixture' }, { status: 503 });
  }, previousFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { opencodeClient } = await import('@/lib/opencode/client');
  const { useProjectContextStore } = await import('@/stores/useProjectContextStore');
  const { useSessionUIStore } = await import('@/sync/session-ui-store');
  const { useConfigStore } = await import('@/stores/useConfigStore');
  const { useSessionGoalArmStore } = await import('@/stores/useSessionGoalArmStore');
  const { PlanView } = await import('./PlanView');
  const sessionActions = useSessionUIStore.getState();
  const keptSessionActions = {
    createSession: sessionActions.createSession,
    initializeNewOpenChamberSession: sessionActions.initializeNewOpenChamberSession,
    setCurrentSession: sessionActions.setCurrentSession,
    sendMessage: sessionActions.sendMessage,
  };
  const { currentProviderId, currentModelId } = useConfigStore.getState();
  const sends: Array<Parameters<typeof sessionActions.sendMessage>> = [];
  useSessionUIStore.setState({
    createSession: async (_title, directory) => ({
      id: 'ses_plan',
      projectID: 'plan-fixture',
      directory: directory ?? '',
      title: 'Plan A',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    }),
    initializeNewOpenChamberSession: () => undefined,
    setCurrentSession: () => undefined,
    sendMessage: async (...args) => {
      sends.push(args);
    },
  });
  // The send dialog starts from the composer's model.
  useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
  // The user armed a goal for their next composer message.
  useSessionGoalArmStore.getState().setArmed(true, 'Next goal');
  const projectRef = { id: 'plan-fixture', path: '/plan-fixture' };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const press = async (element: HTMLElement | null | undefined, label: string) => {
    if (!element) throw new Error(`Missing ${label}: ${document.body.textContent}`);
    await act(async () => { element.click(); });
    await wait(30);
  };
  const button = (text: string) => [...document.querySelectorAll<HTMLElement>('button')].find((element) => element.textContent?.trim() === text);
  try {
    useProjectContextStore.getState().reset();
    await act(async () => root.render(<I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={createWebAPIs()}>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory="/plan-fixture">
        <PlanView savedProjectPlan={{ projectRef, planId: 'A' }} />
      </SyncProvider>
    </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider>));
    await wait(30);

    await press(host.querySelector<HTMLElement>('button[aria-label="Implement plan"]'), 'the implement menu');
    await press([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent?.trim() === 'Send to new session'), 'Send to new session');
    await press(button('Run as goal'), 'Run as goal');
    await press(button('Send'), 'Send');

    expect(sends).toHaveLength(1);
    const goalArm = sends[0]?.[9]?.goalArm;
    expect(goalArm).toMatchObject({ armed: true, settled: false, briefAgent: false });
    expect(goalArm?.objectiveOverride).toContain(plan);
    expect(useSessionGoalArmStore.getState()).toMatchObject({ armed: true, objectiveOverride: 'Next goal' });
  } finally {
    await act(async () => root.unmount());
    useProjectContextStore.getState().reset();
    useSessionUIStore.setState(keptSessionActions);
    useConfigStore.setState({ currentProviderId, currentModelId });
    useSessionGoalArmStore.getState().setArmed(false);
    globalThis.fetch = previousFetch;
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
