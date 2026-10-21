import { afterEach, afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
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

const {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} = await import('./select');

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(() => {
  browser.close();
});

const render = async (element: React.ReactElement) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return {
    rerender: (next: React.ReactElement) => act(async () => root.render(next)),
    get value() {
      const value = container.querySelector<HTMLElement>('[data-slot="select-value"]');
      if (!value) throw new Error('The trigger rendered no value slot');
      return value;
    },
  };
};

type Labels = { usage: string; remaining: string };

const ENGLISH: Labels = { usage: 'Usage', remaining: 'Quota remaining' };

/** The Usage sidebar's display-mode select, with the trigger left to show the chosen item. */
const DisplayMode = ({ value, labels = ENGLISH, valueSlot }: { value: string; labels?: Labels; valueSlot?: React.ReactNode }) => (
  <Select value={value}>
    <SelectTrigger>{valueSlot ?? <SelectValue placeholder="Display mode" />}</SelectTrigger>
    <SelectContent>
      <SelectItem value="usage">{labels.usage}</SelectItem>
      <SelectItem value="remaining">{labels.remaining}</SelectItem>
    </SelectContent>
  </Select>
);

describe('SelectValue without a label from the caller', () => {
  test('names the chosen item by its label', async () => {
    const view = await render(<DisplayMode value="remaining" />);
    expect(view.value.textContent).toBe('Quota remaining');
  });

  test('follows the value and the item labels as they change', async () => {
    const view = await render(<DisplayMode value="remaining" />);
    await view.rerender(<DisplayMode value="usage" />);
    expect(view.value.textContent).toBe('Usage');
    await view.rerender(<DisplayMode value="usage" labels={{ usage: 'Utilisation', remaining: 'Quota restant' }} />);
    expect(view.value.textContent).toBe('Utilisation');
  });

  test('finds items inside groups, fragments, conditionals and mapped lists', async () => {
    const local = ['main', 'develop'];
    const remote = ['origin/main'];
    const Branches = ({ value }: { value: string }) => (
      <Select value={value}>
        <SelectTrigger><SelectValue placeholder="Branch" /></SelectTrigger>
        <SelectContent>
          {local.length === 0 ? null : (
            <>
              <SelectGroup>
                <SelectLabel>Local</SelectLabel>
                {local.map((branch) => <SelectItem key={branch} value={branch}>{`${branch} (local)`}</SelectItem>)}
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Remote</SelectLabel>
                {remote.map((branch) => <SelectItem key={branch} value={`remotes/${branch}`}>{branch}</SelectItem>)}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>
    );
    const view = await render(<Branches value="remotes/origin/main" />);
    expect(view.value.textContent).toBe('origin/main');
    // An item before other groups keeps its label when the later ones hold no match.
    await view.rerender(<Branches value="main" />);
    expect(view.value.textContent).toBe('main (local)');
  });

  test('renders a rich label the way the list shows it', async () => {
    const view = await render(
      <Select value="project">
        <SelectTrigger><SelectValue placeholder="Scope" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="user"><span data-icon="user-3" /><span>Global</span></SelectItem>
          <SelectItem value="project"><span data-icon="folder" /><span>Project</span></SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(view.value.textContent).toBe('Project');
    expect(view.value.querySelector('[data-icon="folder"]')).not.toBeNull();
  });

  test('shows the placeholder while nothing is chosen', async () => {
    const view = await render(<DisplayMode value="" />);
    expect(view.value.textContent).toBe('Display mode');
  });

  test('shows the value when no item declares it', async () => {
    const view = await render(<DisplayMode value="legacy" />);
    expect(view.value.textContent).toBe('legacy');
  });

  test('an open select lists its items while the trigger shows the chosen label', async () => {
    const view = await render(
      <Select value="remaining" defaultOpen>
        <SelectTrigger><SelectValue placeholder="Display mode" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="usage">Usage</SelectItem>
          <SelectItem value="remaining">Quota remaining</SelectItem>
        </SelectContent>
      </Select>,
    );
    const options = [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    expect(options).toEqual(['Usage', 'Quota remaining']);
    expect(view.value.textContent).toBe('Quota remaining');
  });
});

describe('SelectValue with a label from the caller', () => {
  test('keeps the caller label', async () => {
    const view = await render(<DisplayMode value="remaining" valueSlot={<SelectValue>Left this month</SelectValue>} />);
    expect(view.value.textContent).toBe('Left this month');
  });

  test('passes the raw value to a formatting function', async () => {
    const view = await render(
      <DisplayMode value="remaining" valueSlot={<SelectValue>{(value) => `mode: ${value}`}</SelectValue>} />,
    );
    expect(view.value.textContent).toBe('mode: remaining');
  });
});
