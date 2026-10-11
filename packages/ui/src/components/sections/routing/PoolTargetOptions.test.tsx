import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import type { ModelRouteTarget } from '@/lib/routing/modelRoutesApi';

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
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
    HTMLInputElement: happyWindow.HTMLInputElement,
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

const renderOptions = async (target: ModelRouteTarget, onChange: (next: ModelRouteTarget) => void) => {
  const dom = installDom();
  // Imported after the DOM exists: react-dom decides at load time whether input events are native.
  const { createRoot } = await import('react-dom/client');
  const { PoolTargetOptions } = await import('./PoolTargetOptions');
  const { I18nProvider } = await import('@/lib/i18n');
  const root = createRoot(dom.container);
  mounted = { root, restore: dom.restore };
  await act(async () => {
    root.render(
      <I18nProvider>
        <PoolTargetOptions target={target} onChange={onChange} />
      </I18nProvider>,
    );
  });
  return dom.container;
};

const buttonWith = (container: HTMLElement, text: string): HTMLButtonElement => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.trim() === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button;
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

describe('PoolTargetOptions', () => {
  let changes: ModelRouteTarget[] = [];
  const onChange = (next: ModelRouteTarget) => {
    changes.push(next);
  };

  beforeEach(() => {
    changes = [];
  });

  afterEach(async () => {
    if (!mounted) return;
    const current = mounted;
    mounted = null;
    await act(async () => current.root.unmount());
    current.restore();
  });

  test('keeps a target as a plain string until it gets an option, then saves the default variant', async () => {
    const container = await renderOptions('p/cheap', onChange);
    await act(async () => buttonWith(container, 'Options').click());
    await typeInto(inputNamed(container, 'Default variant'), 'max');
    expect(changes.at(-1)).toEqual({ model: 'p/cheap', defaultVariant: 'max' });
  });

  test('saves the time a target leaves the pool from the date input', async () => {
    const container = await renderOptions('p/cheap', onChange);
    await act(async () => buttonWith(container, 'Options').click());
    const until = container.querySelector<HTMLInputElement>('input[type="datetime-local"]');
    if (!until) throw new Error('no date input');
    // The value goes in through the native setter, so React's tracked value does not hide the change.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(until, '2030-01-01T06:00');
      until.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(changes.at(-1)).toEqual({ model: 'p/cheap', until: new Date('2030-01-01T06:00').getTime() });
  });

  test('adds a variant remap to the target', async () => {
    const container = await renderOptions('p/cheap', onChange);
    await act(async () => buttonWith(container, 'Options').click());
    await typeInto(inputNamed(container, 'Pool variant'), 'low');
    await typeInto(inputNamed(container, 'Target variant'), 'high');
    await act(async () => buttonWith(container, 'Add remap').click());
    expect(changes.at(-1)).toEqual({ model: 'p/cheap', variants: { low: 'high' } });
  });

  test('removes a remap with its Remove button and drops the empty map', async () => {
    const container = await renderOptions({ model: 'p/cheap', variants: { low: 'high' } }, onChange);
    await act(async () => buttonWith(container, 'Options').click());
    await act(async () => buttonWith(container, 'Remove').click());
    expect(changes.at(-1)).toEqual('p/cheap');
  });
});
