/**
 * Regression guard: the work-status card showed up shifted left and cut off
 * after a cold start.
 *
 * The right slot (the context panel's aside) holds the card's host, anchored
 * right, and the closed context panel's content, which is wider than the
 * card's column. With `overflow: hidden` on either axis the slot is a scroll
 * container, and `overflow-x: clip` beside `overflow-y: hidden` computes to
 * `hidden` as well. On mount the panel's tab strip runs `scrollIntoView` on
 * its active tab, which scrolled the slot sideways; the right-anchored card
 * moved left with the content and lost its left edge to the slot's clip.
 *
 * The test DOM has no layout engine, so the scroll and the clip themselves
 * cannot be measured here. What it checks is the overflow contract the
 * rendered slot carries: the classes and inline styles that decide whether
 * the browser clips or scrolls it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DIRECTORY, installDom, renderContextPanels } from './contextPanelHarness';

const dom = installDom();
const { useUIStore } = await import('@/stores/useUIStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');

let root: Root;

const rightSlot = (): HTMLElement => {
  const slot = document.querySelector<HTMLElement>('[data-right-slot]');
  if (!slot) throw new Error('the right slot is not mounted');
  return slot;
};

// Any class that makes an axis scroll or hide its overflow, on either axis.
const SCROLLING_CLASS = /^overflow(-[xy])?-(hidden|auto|scroll)$/;

beforeEach(async () => {
  useUIStore.setState({ contextPanelByDirectory: {} });
  useDirectoryStore.setState({ currentDirectory: DIRECTORY });
  useUIStore.getState().openContextPanelTab(DIRECTORY, { mode: 'context' });
  root = createRoot(dom.container);
  await renderContextPanels(root);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

afterAll(async () => {
  await dom.restore();
});

describe('right slot cannot be scrolled sideways', () => {
  test('the open slot clips on both axes instead of hiding overflow', () => {
    const slot = rightSlot();

    expect(slot.getAttribute('data-context-panel-open')).toBe('true');
    expect(slot.classList.contains('overflow-clip')).toBe(true);
    expect([...slot.classList].some((name) => SCROLLING_CLASS.test(name))).toBe(false);
  });

  test('the closed slot, whose content is wider than the card, still clips instead of scrolling', async () => {
    await act(async () => useUIStore.getState().closeContextZone(DIRECTORY, 'right'));
    const slot = rightSlot();

    expect(slot.getAttribute('data-context-panel-open')).toBe('false');
    expect(slot.classList.contains('overflow-clip')).toBe(true);
    expect([...slot.classList].some((name) => SCROLLING_CLASS.test(name))).toBe(false);
  });

  test('the slot sets no inline overflow that would turn clip into a scroll container', () => {
    const slot = rightSlot();

    for (const value of [slot.style.overflow, slot.style.overflowX, slot.style.overflowY]) {
      expect(['', 'clip', 'visible']).toContain(value);
    }
  });
});
