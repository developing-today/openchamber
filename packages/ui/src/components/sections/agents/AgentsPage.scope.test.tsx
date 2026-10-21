import { afterAll, afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import('react-dom/client');
const { AgentsPage } = await import('./AgentsPage');
const { I18nProvider } = await import('@/lib/i18n');
const { useAgentsStore } = await import('@/stores/useAgentsStore');

const initialAgentsState = useAgentsStore.getState();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  useAgentsStore.setState(initialAgentsState, true);
});

afterAll(() => {
  browser.close();
});

/** The page for an agent that is still a draft, where the scope select is shown. */
const renderDraft = async (scope: 'user' | 'project') => {
  useAgentsStore.setState({ selectedAgentName: 'reviewer', agentDraft: { name: 'reviewer', scope } });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<I18nProvider><AgentsPage /></I18nProvider>));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const value = container.querySelector<HTMLElement>('[data-slot="select-value"]');
  if (!value) throw new Error('The draft rendered no scope select');
  return value;
};

test('the scope trigger shows the chosen scope with its icon', async () => {
  const value = await renderDraft('project');
  expect(value.textContent).toBe('Project');
  expect(value.querySelector('use')?.getAttribute('href')).toBe('#oc-folder');
});

test('the scope trigger names the global scope for a user-level draft', async () => {
  expect((await renderDraft('user')).textContent).toBe('Global');
});
