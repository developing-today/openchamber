/**
 * Regression guard for https://github.com/openchamber/openchamber/issues/2644
 *
 * Escape while focus is inside the terminal must reach the PTY (e.g. Vim
 * Normal mode). The context panel still closes on Escape when focus is on
 * non-terminal panel chrome.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DIRECTORY,
  TERMINAL_DIRECTORY,
  installDom,
  pressEscape,
  ptyKeys,
  renderContextPanels,
} from './contextPanelHarness';

const dom = installDom();
const { useUIStore } = await import('@/stores/useUIStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');

let root: Root;

const isPanelOpen = (): boolean => useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.isOpen === true;
const terminalInput = (): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>('[aria-label="terminal input"]');
  if (!input) throw new Error('the terminal is not mounted');
  return input;
};
const outsideButton = (): HTMLButtonElement => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent === 'Outside the terminal');
  if (!button) throw new Error('the pane chrome is not mounted');
  return button;
};

beforeEach(async () => {
  useUIStore.setState({ contextPanelByDirectory: {} });
  useDirectoryStore.setState({ currentDirectory: DIRECTORY });
  ptyKeys.length = 0;
  // Opening the terminal reveals the right zone with the terminal active.
  useUIStore.getState().openContextPanelTab(DIRECTORY, { mode: 'terminal', targetDirectory: TERMINAL_DIRECTORY });
  root = createRoot(dom.container);
  await renderContextPanels(root);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

afterAll(async () => {
  await dom.restore();
});

describe('issue #2644: Escape in terminal must not close the context panel', () => {
  test('Escape typed in the terminal reaches the PTY and leaves the panel open', async () => {
    expect(isPanelOpen()).toBe(true);

    const notPrevented = await pressEscape(terminalInput());

    expect(ptyKeys).toEqual(['Escape']);
    expect(notPrevented).toBe(true);
    expect(isPanelOpen()).toBe(true);
  });

  test('Escape on the pane chrome outside the terminal closes the zone', async () => {
    const notPrevented = await pressEscape(outsideButton());

    expect(isPanelOpen()).toBe(false);
    expect(notPrevented).toBe(false);
    expect(ptyKeys).toEqual([]);
  });

  test('Escape on the panel frame itself closes the zone', async () => {
    const frame = document.querySelector<HTMLElement>('aside[data-context-panel]');
    expect(frame).not.toBeNull();

    await pressEscape(frame!);

    expect(isPanelOpen()).toBe(false);
    expect(ptyKeys).toEqual([]);
  });
});
