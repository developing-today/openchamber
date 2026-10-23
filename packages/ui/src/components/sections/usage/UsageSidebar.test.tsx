import { afterAll, afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLButtonElement: browser.HTMLButtonElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import('react-dom/client');
const { UsageSidebar } = await import('./UsageSidebar');
const { I18nProvider } = await import('@/lib/i18n');
const { useQuotaStore } = await import('@/stores/useQuotaStore');

const initialQuotaState = useQuotaStore.getState();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  useQuotaStore.setState(initialQuotaState, true);
});

afterAll(() => {
  browser.close();
});

const renderSidebar = async (displayMode: 'usage' | 'remaining') => {
  // The sidebar reads the saved mode from the runtime on mount. This test has
  // no runtime, and a late answer would put the default mode back.
  useQuotaStore.setState({ displayMode, loadSettings: async () => {} });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<I18nProvider><UsageSidebar /></I18nProvider>));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const value = container.querySelector<HTMLElement>('[data-slot="select-value"]');
  if (!value) throw new Error('The display-mode select rendered no value slot');
  return value;
};

test('the display-mode trigger names the chosen mode', async () => {
  expect((await renderSidebar('remaining')).textContent).toBe('Quota remaining');
});

test('the display-mode trigger names the default mode', async () => {
  expect((await renderSidebar('usage')).textContent).toBe('Usage');
});
