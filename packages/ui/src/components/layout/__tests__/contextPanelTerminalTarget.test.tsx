/**
 * Regression guard for persisted context-panel terminal targets.
 *
 * The context panel keeps the singleton terminal pane mounted even when another
 * context tab is active. The mounted `TerminalView` must therefore receive its
 * directory from the stored terminal tab itself, not from whichever tab is
 * currently active.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DIRECTORY, TERMINAL_DIRECTORY, installDom, renderContextPanels, terminalRenders } from './contextPanelHarness';

const dom = installDom();
const { useUIStore } = await import('@/stores/useUIStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');

let root: Root;

const tabs = () => useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.tabs ?? [];
const terminalTabId = (): string => tabs().find((tab) => tab.mode === 'terminal')?.id ?? '';
const lastTerminalRender = () => terminalRenders.at(-1);

beforeEach(async () => {
  useUIStore.setState({ contextPanelByDirectory: {} });
  useDirectoryStore.setState({ currentDirectory: DIRECTORY });
  terminalRenders.length = 0;
  // The terminal opens first, then a context tab that has no directory of its own becomes active.
  const store = useUIStore.getState();
  store.openContextPanelTab(DIRECTORY, { mode: 'terminal', targetDirectory: TERMINAL_DIRECTORY });
  store.openContextPanelTab(DIRECTORY, { mode: 'context' });
  root = createRoot(dom.container);
  await renderContextPanels(root);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

afterAll(async () => {
  await dom.restore();
});

describe('context panel terminal target wiring', () => {
  test('the kept-mounted terminal gets its stored directory while another tab is active', () => {
    expect(terminalRenders.length).toBeGreaterThan(0);
    expect(lastTerminalRender()).toEqual({ directory: TERMINAL_DIRECTORY, visible: false });
  });

  test('the terminal is visible with its stored directory once its tab is active', async () => {
    await act(async () => useUIStore.getState().setActiveContextPanelTab(DIRECTORY, terminalTabId()));

    expect(lastTerminalRender()).toEqual({ directory: TERMINAL_DIRECTORY, visible: true });
  });
});
