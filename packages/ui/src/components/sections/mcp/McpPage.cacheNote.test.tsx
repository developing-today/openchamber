import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

// Same page setup as McpPage.test.tsx. Kept in its own file because that file closes
// its window after its single test.
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  PointerEvent: browser.PointerEvent, MouseEvent: browser.MouseEvent, KeyboardEvent: browser.KeyboardEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ home: '/test' }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { settingsDict } = await import('@/lib/i18n/messages/en.settings');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { McpPage } = await import('./McpPage');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterAll(async () => { await act(async () => root.unmount()); fetchSpy.mockRestore(); browser.close(); });

const enableNote = settingsDict['settings.mcp.page.server.enableCacheNote'];
const codemodeNote = settingsDict['settings.mcp.page.advanced.codemodeCacheNote'];

const showServer = async (server: { name: string; type: 'remote'; url: string; codemode?: boolean }) => {
  useMcpStore.setState({ refresh: async () => {} });
  useMcpConfigStore.setState({
    selectedMcpName: server.name, serversByDirectory: { __default__: [server] },
    getMcpByName: () => useMcpConfigStore.getState().serversByDirectory.__default__?.[0] ?? null,
    updateMcp: async () => ({ ok: true }),
  });
  await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
};

// A server with code mode off has its tools in the request's tool list, so enabling or
// disabling it costs a running session its prompt cache; the code mode choice moves the
// tools in or out of that list, so it always does.
test('the Enabled row warns about the prompt cache only for a server with code mode off', async () => {
  await showServer({ name: 'direct', type: 'remote', url: 'https://direct.test', codemode: false });
  expect(container.textContent).toContain(enableNote);

  await act(async () => { root.render(null); });
  await showServer({ name: 'catalog', type: 'remote', url: 'https://catalog.test' });
  expect(container.textContent).not.toContain(enableNote);
});

test('the code mode selector carries the prompt cache note', async () => {
  await act(async () => { root.render(null); });
  await showServer({ name: 'catalog', type: 'remote', url: 'https://catalog.test' });
  const trigger = [...container.querySelectorAll<HTMLElement>('button')]
    .find((button) => button.textContent?.includes(settingsDict['settings.mcp.page.advanced.configure']));
  if (!trigger) throw new Error('Missing advanced options trigger');
  await act(async () => { trigger.click(); });
  const selector = container.querySelector(`[aria-label="${settingsDict['settings.mcp.page.advanced.codemode']}"]`);
  expect(selector).not.toBeNull();
  expect(container.textContent).toContain(codemodeNote);
});
