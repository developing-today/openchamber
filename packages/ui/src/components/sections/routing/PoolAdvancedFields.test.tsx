import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { ModelRoute } from '@/lib/routing/modelRoutesApi';

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

const renderFields = async (route: ModelRoute, onChange: (next: ModelRoute) => void) => {
  const { PoolAdvancedFields } = await import('./PoolAdvancedFields');
  const { I18nProvider } = await import('@/lib/i18n');
  const dom = installDom();
  const root = createRoot(dom.container);
  mounted = { root, restore: dom.restore };
  await act(async () => {
    root.render(
      <I18nProvider>
        <PoolAdvancedFields route={route} onChange={onChange} />
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

const switchNamed = (container: HTMLElement, label: string): HTMLElement => {
  const control = container.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`);
  if (!control) throw new Error(`no switch labelled "${label}"`);
  return control;
};

// Fields commit when the user leaves them; happy-dom does not route synthetic input events to React.
const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event('focusout', { bubbles: true }));
  });
};

describe('PoolAdvancedFields', () => {
  let changes: ModelRoute[] = [];
  const onChange = (next: ModelRoute) => {
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

  test('asks for two requests in total by default, and saves the attempts as typed', async () => {
    const container = await renderFields({ targets: ['p/cheap'] }, onChange);
    const attempts = inputNamed(container, 'Total requests before failover');
    expect(attempts.placeholder).toBe('2');
    await typeInto(attempts, '3');
    expect(changes.at(-1)).toMatchObject({ attempts: 3 });
  });

  test('saves the health window and the slow-request threshold separately', async () => {
    const container = await renderFields({ targets: ['p/cheap'], health: { sampleWindow: 5 } }, onChange);
    await typeInto(inputNamed(container, 'Requests counted for health'), '4');
    expect(changes.at(-1)).toMatchObject({ health: { sampleWindow: 4 } });
    await typeInto(inputNamed(container, 'Slow requests that mark a target degraded'), '2');
    expect(changes.at(-1)).toMatchObject({ health: { sampleWindow: 5, slowThreshold: 2 } });
  });

  test('saves the time limits in milliseconds, and the switch that turns the first-token timeout off', async () => {
    const container = await renderFields({ targets: ['p/cheap'] }, onChange);
    await typeInto(inputNamed(container, 'First response timeout (seconds)'), '30');
    expect(changes.at(-1)).toMatchObject({ health: { firstTokenTimeoutMs: 30000 } });
    await typeInto(inputNamed(container, 'Slow above (seconds)'), '45');
    expect(changes.at(-1)).toMatchObject({ health: { maxResponseTimeMs: 45000 } });
    await act(async () => switchNamed(container, 'Never time out the first token').click());
    expect(changes.at(-1)).toMatchObject({ health: { firstTokenTimeoutMs: false } });
  });

  test('saves the failure and quota cooldowns in seconds, and the slow-rate floor as typed', async () => {
    const container = await renderFields({ targets: ['p/cheap'] }, onChange);
    await typeInto(inputNamed(container, 'Cooldown after failure (seconds)'), '90');
    expect(changes.at(-1)).toMatchObject({ health: { cooldownMs: 90000 } });
    await typeInto(inputNamed(container, 'Cooldown when quota runs out (seconds)'), '1200');
    expect(changes.at(-1)).toMatchObject({ health: { quotaCooldownMs: 1200000 } });
    await typeInto(inputNamed(container, 'Slow below (tokens per second)'), '12.5');
    expect(changes.at(-1)).toMatchObject({ health: { minOutputTokensPerSecond: 12.5 } });
  });

  test('saves a tokens-per-day allowance against the model it names', async () => {
    const container = await renderFields({ targets: ['p/cheap', 'opencode-route/other'] }, onChange);
    await typeInto(inputNamed(container, 'Tokens per day'), '500000');
    expect(changes.at(-1)).toMatchObject({ budgets: { 'p/cheap': { tokensPerDay: 500000 } } });
  });

  test('shows a weight per model target only when the selection is weighted, and saves it by reference', async () => {
    const plain = await renderFields({ targets: ['p/cheap'] }, onChange);
    expect(plain.querySelector('input[aria-label="Weight: p/cheap"]')).toBeNull();
    await act(async () => {
      mounted?.root.unmount();
    });
    mounted?.restore();
    mounted = null;

    const weighted = await renderFields({ targets: ['p/cheap#high'], selection: 'weighted' }, onChange);
    await typeInto(inputNamed(weighted, 'Weight: p/cheap'), '3');
    expect(changes.at(-1)).toMatchObject({ weights: { 'p/cheap': 3 } });
  });
});
