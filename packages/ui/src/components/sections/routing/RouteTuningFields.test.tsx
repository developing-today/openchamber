import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { ModelRouteTuning } from '@/lib/routing/modelRoutesApi';

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'KeyboardEvent',
  'PointerEvent',
  'localStorage',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    Event: happyWindow.Event,
    KeyboardEvent: happyWindow.KeyboardEvent,
    PointerEvent: happyWindow.PointerEvent,
    localStorage: happyWindow.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

let mounted: { root: Root; restore: () => void } | null = null;

const renderTuning = async (tuning: ModelRouteTuning | null, onSave: (next: ModelRouteTuning | null) => void) => {
  const { RouteTuningFields } = await import('./RouteTuningFields');
  const { I18nProvider } = await import('@/lib/i18n');
  const dom = installDom();
  const root = createRoot(dom.container);
  mounted = { root, restore: dom.restore };
  await act(async () => {
    root.render(
      <I18nProvider>
        <RouteTuningFields tuning={tuning} onSave={onSave} />
      </I18nProvider>,
    );
  });
  return dom.container;
};

const inputNamed = (container: HTMLElement, label: string): HTMLInputElement => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`no input labelled "${label}"`);
  return input;
};

// Fields commit when the user leaves them; happy-dom does not route synthetic input events to React.
const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event('focusout', { bubbles: true }));
  });
};

describe('RouteTuningFields', () => {
  let saves: Array<ModelRouteTuning | null> = [];
  const onSave = (next: ModelRouteTuning | null) => {
    saves.push(next);
  };

  beforeEach(() => {
    saves = [];
  });

  afterEach(async () => {
    if (!mounted) return;
    const current = mounted;
    mounted = null;
    await act(async () => current.root.unmount());
    current.restore();
  });

  test('turns the automatic review on from its default', async () => {
    const container = await renderTuning(null, onSave);
    const toggle = container.querySelector<HTMLElement>('[role="switch"]');
    if (!toggle) throw new Error('no review switch');
    await act(async () => toggle.click());
    expect(saves.at(-1)).toEqual({ enabled: true });
  });

  test('turns the review off as an explicit false, which the form keeps', async () => {
    const container = await renderTuning({ enabled: true, windowHours: 6 }, onSave);
    const toggle = container.querySelector<HTMLElement>('[role="switch"]');
    if (!toggle) throw new Error('no review switch');
    await act(async () => toggle.click());
    expect(saves.at(-1)).toEqual({ enabled: false, windowHours: 6 });
  });

  test('saves the minutes between reviews and the hours of history they read', async () => {
    const container = await renderTuning({ enabled: true }, onSave);
    await typeInto(inputNamed(container, 'Minutes between reviews'), '30');
    expect(saves.at(-1)).toEqual({ enabled: true, intervalMinutes: 30 });
    await typeInto(inputNamed(container, 'Hours of history to review'), '6');
    expect(saves.at(-1)).toEqual({ enabled: true, windowHours: 6 });
  });

  test('keeps the notes written by hand when another review field is saved', async () => {
    const notes = ['openai/gpt-6: reset at 2026-01-01T06:00:00Z'];
    const container = await renderTuning({ enabled: true, notes }, onSave);
    await typeInto(inputNamed(container, 'Hours of history to review'), '12');
    expect(saves.at(-1)).toEqual({ enabled: true, notes, windowHours: 12 });
  });

  test('saves null, which removes the settings, once the last field is cleared', async () => {
    const container = await renderTuning({ intervalMinutes: 30 }, onSave);
    await typeInto(inputNamed(container, 'Minutes between reviews'), '');
    expect(saves.at(-1)).toBeNull();
  });
});
