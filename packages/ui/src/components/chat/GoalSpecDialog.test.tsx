import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import type { GoalSpecResult, GoalSubmitChoice } from '@/lib/goalWriter';
import type { GoalSpecDialogRequest } from './GoalSpecDialog';

// React DOM and the Base UI dialog probe for a DOM when first imported; without
// one the dialog never mounts its popup. Give the probe a document, then
// restore the caller's globals.
const importWindow = new Window();
// The writer picker's model stores read localStorage when they load.
const importGlobals = ['window', 'document', 'localStorage'] as const;
const previousImportGlobals = importGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: importWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: importWindow.document, configurable: true, writable: true });
Object.defineProperty(globalThis, 'localStorage', { value: importWindow.localStorage, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { GoalSpecDialog } = await import('./GoalSpecDialog');
for (const [name, descriptor] of previousImportGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
void importWindow.happyDOM.close();

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT', 'Event', 'CustomEvent', 'MutationObserver'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MutationObserver: win.MutationObserver };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    void win.happyDOM.close();
  } };
};

const written: GoalSpecResult = { ok: true, spec: '## Objective\nDark mode', providerID: 'p', modelID: 'm', variant: null };
const base = { sessionModel: null, directory: null } as const;

describe('GoalSpecDialog', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let choices: GoalSubmitChoice[];
  let cancels: number;

  const render = (request: Omit<GoalSpecDialogRequest, 'id'>) => act(async () => root.render(
    <I18nProvider>
      <GoalSpecDialog
        request={{ id: 1, ...request }}
        onCancel={() => { cancels += 1; }}
        onSubmit={(choice) => { choices.push(choice); }}
      />
    </I18nProvider>,
  ));
  const button = (label: string): HTMLButtonElement => {
    const match = Array.from(document.querySelectorAll('button')).find((element) => element.textContent?.trim() === label);
    if (!match) throw new Error(`No button "${label}" in: ${document.body.textContent}`);
    return match;
  };
  const click = (label: string) => act(async () => { button(label).click(); });

  beforeEach(() => {
    choices = [];
    cancels = 0;
    dom = installDom();
    root = createRoot(dom.container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });

  test('shows the written spec for approval and sends it either way', async () => {
    await render({ ...base, trigger: 'armed', review: true, defaultSendMode: 'with-message', write: async () => written });

    expect(document.querySelector('textarea')?.value).toBe('## Objective\nDark mode');
    expect(document.body.textContent).toContain('Written by p/m');

    await click('Send message with goal');
    await click('Send goal as message');
    expect(choices).toEqual([
      { kind: 'spec', spec: '## Objective\nDark mode', sendMode: 'with-message', ignoreLimit: false },
      { kind: 'spec', spec: '## Objective\nDark mode', sendMode: 'goal-as-message', ignoreLimit: false },
    ]);
  });

  test('without review the spec goes out as soon as it is written, in the default mode', async () => {
    await render({ ...base, trigger: 'auto-create', review: false, defaultSendMode: 'goal-as-message', write: async () => written });

    expect(choices).toEqual([{ kind: 'spec', spec: '## Objective\nDark mode', sendMode: 'goal-as-message', ignoreLimit: false }]);
  });

  test('a failure waits for the user even without review, and can be retried', async () => {
    let attempts = 0;
    await render({
      ...base,
      trigger: 'armed',
      review: false,
      defaultSendMode: 'with-message',
      write: async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, message: 'No small model available' } : written;
      },
    });

    expect(choices).toEqual([]);
    expect(document.body.textContent).toContain('No small model available');

    await click('Try again');
    expect(attempts).toBe(2);
    expect(choices).toEqual([{ kind: 'spec', spec: '## Objective\nDark mode', sendMode: 'with-message', ignoreLimit: false }]);
  });

  test('skipping keeps an armed goal as typed, and sends an automatic one without a goal', async () => {
    const pending = () => new Promise<GoalSpecResult>(() => undefined);
    await render({ ...base, trigger: 'armed', review: true, defaultSendMode: 'with-message', write: pending });
    await click('Use my message as the goal');
    await click('Cancel');

    await render({ ...base, trigger: 'auto-create', review: true, defaultSendMode: 'with-message', write: pending });
    await click('Send without a goal');

    expect(choices).toEqual([{ kind: 'unchanged' }, { kind: 'none' }]);
    expect(cancels).toBe(1);
  });

  test('the length limit switch applies to the next writing run and to the goal sent', async () => {
    const runs: boolean[] = [];
    await render({
      ...base,
      trigger: 'armed',
      review: true,
      defaultSendMode: 'with-message',
      write: async (_signal, options) => {
        runs.push(options.ignoreLimit);
        return written;
      },
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="More goal options"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((element) => element.textContent?.includes('No length limit for this goal'));
    if (!item) throw new Error(`No limit switch in: ${document.body.textContent}`);
    await act(async () => { item.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
    await click('Write again');
    await click('Send message with goal');

    expect(runs).toEqual([false, true]);
    expect(choices).toEqual([{ kind: 'spec', spec: '## Objective\nDark mode', sendMode: 'with-message', ignoreLimit: true }]);
  });
});
