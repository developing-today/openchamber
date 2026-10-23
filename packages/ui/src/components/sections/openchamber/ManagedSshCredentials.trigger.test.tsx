import { afterAll, afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { GitAPI, GitManagedSshResult, RuntimeAPIs } from '@/lib/api/types';

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
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { I18nProvider } = await import('@/lib/i18n');
const { ManagedSshCredentials } = await import('./ManagedSshCredentials');

const savedKey = 'ocgit:v1:ssh:a2V5X29uZQ';
const inventory: GitManagedSshResult = { status: 'available',
  credentials: [{ credentialId: savedKey, label: 'Work laptop', fingerprint: `SHA256:${'a'.repeat(43)}`, capability: { status: 'ready' } }],
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(() => {
  browser.close();
});

/** The picker of an identity that already has a saved key, with the inventory read held open. */
const mountWithSavedKey = async () => {
  let pending: { resolve: (result: GitManagedSshResult) => void; reject: (error: Error) => void } | undefined;
  const managedSshCredentials: NonNullable<GitAPI['managedSshCredentials']> = async () =>
    new Promise((resolve, reject) => { pending = { resolve, reject }; });
  const unused = (): never => { throw new Error('Unexpected API access'); };
  const git = new Proxy({ managedSshCredentials }, { get: (target, key) => key === 'managedSshCredentials' ? target.managedSshCredentials : unused });
  // SAFETY: Every other Git method is a throwing function supplied by the proxy above.
  const gitApi = git as GitAPI;
  const apis: RuntimeAPIs = {
    runtime: { platform: 'web', isVSCode: false, isDesktop: false }, git: gitApi,
    get sourceControl() { return unused(); }, get terminal() { return unused(); }, get files() { return unused(); },
    get settings() { return unused(); }, get permissions() { return unused(); }, get notifications() { return unused(); },
  };
  const Editor = () => {
    const [value, onChange] = React.useState(savedKey);
    return <ManagedSshCredentials selection={{ value, onChange }} />;
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><I18nProvider><Editor /></I18nProvider></RuntimeAPIContext.Provider>));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return {
    get trigger() {
      const value = container.querySelector<HTMLElement>('[data-slot="select-value"]');
      if (!value) throw new Error('The picker rendered no value slot');
      return value.textContent;
    },
    answer: async (result: GitManagedSshResult) => {
      if (!pending) throw new Error('No pending inventory read');
      await act(async () => pending?.resolve(result));
    },
    fail: async () => {
      if (!pending) throw new Error('No pending inventory read');
      await act(async () => pending?.reject(new Error('offline')));
    },
  };
};

test('the trigger hides the saved reference while the list loads, then names the key', async () => {
  const picker = await mountWithSavedKey();
  expect(picker.trigger).toBe('SSH keys');
  await picker.answer(inventory);
  expect(picker.trigger).toBe(`Work laptop · SHA256:${'a'.repeat(43)}`);
});

test('a failed read keeps the saved reference out of the trigger', async () => {
  const picker = await mountWithSavedKey();
  await picker.fail();
  expect(picker.trigger).toBe('SSH keys');
});

test('a host without managed keys keeps the saved reference out of the trigger', async () => {
  const picker = await mountWithSavedKey();
  await picker.answer({ status: 'unsupported', reason: 'host-setup-required' });
  expect(picker.trigger).toBe('SSH keys');
});
