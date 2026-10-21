import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { PoolProblems } from '@/lib/routing/modelRoutesApi';

// The OpenChamber server as the section reaches it, behind `fetch`, so the
// real client parses every pool and the tests read the bodies it sends.
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** The pools the server holds, by id: any JSON, as an OpenCode config can hold it. */
interface ServerPools {
  [id: string]: Json;
}

type PutBody = { routes?: ServerPools; tuning?: Json; force?: boolean };

// Hand-rolled recorders rather than bun's `mock()`: its installed types omit
// `.mock`/`mockClear`, while the runtime behaviour is all these tests need.
const routeFetches: string[] = [];
const routeSaves: Json[] = [];
const forcedSaves: boolean[] = [];
const tuningSaves: Json[] = [];
let serverRoutes: ServerPools = {};
let serverTuning: Json = null;
let serverProblems: PoolProblems = {};
let saveError: string | null = null;
// When set, a save that is not forced is refused with these problems.
let refusal: PoolProblems | null = null;

const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const serverState = () => JSON.stringify({ routes: serverRoutes, tuning: serverTuning, problems: serverProblems });

const respond = (url: string, method: string, text: string): Response => {
  if (url === '/api/model-routes' && method === 'GET') {
    routeFetches.push('fetch');
    return reply(serverState());
  }
  if (url === '/api/model-routes' && method === 'PUT') {
    const body: PutBody = JSON.parse(text);
    if (body.routes) {
      routeSaves.push(body.routes);
      forcedSaves.push(body.force === true);
    }
    if (body.tuning !== undefined) tuningSaves.push(body.tuning);
    if (saveError) return reply(JSON.stringify({ error: saveError }), 500);
    if (body.routes && refusal && body.force !== true) return reply(JSON.stringify({ error: 'refused', problems: refusal }), 400);
    if (body.routes) serverRoutes = body.routes;
    if (body.tuning !== undefined) serverTuning = body.tuning;
    return reply(serverState());
  }
  if (url.startsWith('/api/model-routes/stats')) return reply(JSON.stringify({ available: false, reason: 'no-database' }));
  return new Response('', { status: 404 });
};

const { useConfigStore } = await import('@/stores/useConfigStore');
const { useRoutingStore } = await import('@/stores/useRoutingStore');

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLTextAreaElement',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'MutationObserver',
  'ResizeObserver',
  'cancelAnimationFrame',
  'getComputedStyle',
  'requestAnimationFrame',
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
    HTMLTextAreaElement: happyWindow.HTMLTextAreaElement,
    Event: happyWindow.Event,
    KeyboardEvent: happyWindow.KeyboardEvent,
    MouseEvent: happyWindow.MouseEvent,
    PointerEvent: happyWindow.PointerEvent,
    MutationObserver: happyWindow.MutationObserver,
    ResizeObserver: happyWindow.ResizeObserver,
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
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

const textModel = (id: string, cost: number, context: number) => ({
  id,
  modelID: id,
  providerID: 'p',
  name: id,
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [],
  time: { released: 0 },
  cost: [{ input: cost, output: cost, cache: { read: 0, write: 0 } }],
  status: 'active',
  enabled: true,
  limit: { context, output: 1000 },
});

// Lets the fetches a step started answer and React render what they returned.
const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const renderSection = async () => {
  const dom = installDom();
  // Imported after the DOM exists: Base UI and react-dom read the window when their modules load.
  const { createRoot } = await import('react-dom/client');
  const { ModelPoolsSection } = await import('./ModelPoolsSection');
  const { I18nProvider } = await import('@/lib/i18n');
  const root = createRoot(dom.container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <ModelPoolsSection />
      </I18nProvider>,
    );
  });
  await settle();
  return {
    dom,
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
};

const findByAriaLabel = (container: HTMLElement, selector: string, label: string) => {
  const found = [...container.querySelectorAll<HTMLElement>(selector)].find((el) => el.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no ${selector} labelled "${label}"`);
  return found;
};
const findInput = (container: HTMLElement, label: string) => findByAriaLabel(container, 'input', label) as HTMLInputElement;
const findSwitch = (container: HTMLElement, label: string) => findByAriaLabel(container, '[role="switch"]', label);
// The classes an element lacks, so a failure names them.
const missingClasses = (element: Element, classes: string[]) => classes.filter((name) => !element.classList.contains(name));

// Fields commit when the user leaves them; happy-dom does not route synthetic input events to React.
const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event('focusout', { bubbles: true }));
  });
  await settle();
};

// A textarea saves nothing until Apply, so it takes the edit the way React reads one: the native setter, then an input event.
const editTextArea = async (textarea: HTMLTextAreaElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const fire = (target: Element, type: string) => {
  const init = { bubbles: true, cancelable: true, button: 0 };
  target.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse' }) : new MouseEvent(type, init));
};

// A press on the trigger opens the popup. An option commits only once a hover has highlighted it, so the
// pick hovers first and presses in a later step; both steps run in their own act so React renders between them.
const pickOption = async (container: HTMLElement, label: string, option: string) => {
  const trigger = findByAriaLabel(container, '[role="combobox"]', label);
  await act(async () => {
    fire(trigger, 'pointerdown');
    fire(trigger, 'mousedown');
  });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent?.trim() === option);
  if (!item) throw new Error(`no option "${option}"`);
  await act(async () => {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) fire(item, type);
  });
  await act(async () => {
    fire(item, 'pointerdown');
    fire(item, 'mousedown');
    fire(item, 'pointerup');
    fire(item, 'mouseup');
    fire(item, 'click');
  });
  await settle();
};

const expandPool = async (container: HTMLElement, poolName = 'kept') => {
  const row = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')].find((el) => el.textContent?.includes(poolName));
  expect(row).toBeTruthy();
  await act(async () => row!.click());
};

const clickButton = async (container: HTMLElement, text: string) => {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === text);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
  await settle();
};

const openAdvanced = async (container: HTMLElement, poolName = 'kept') => {
  await expandPool(container, poolName);
  await clickButton(container, 'Show advanced options');
};

describe('ModelPoolsSection', () => {
  let root: Root | null = null;

  beforeEach(() => {
    routeFetches.length = 0;
    routeSaves.length = 0;
    forcedSaves.length = 0;
    tuningSaves.length = 0;
    serverRoutes = {};
    serverTuning = null;
    serverProblems = {};
    saveError = null;
    refusal = null;
    spyOn(globalThis, 'fetch').mockImplementation(async (input, init) =>
      respond(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : ''),
    );
    useConfigStore.setState({
      providers: [
        {
          id: 'p',
          name: 'p',
          models: [textModel('cheap', 1, 8000), textModel(' dear', 10, 200000)],
        },
      ],
    } as never);
    useRoutingStore.setState({ decisions: {} } as never);
  });

  afterEach(async () => {
    mock.restore();
    if (root) {
      const mounted = root;
      root = null;
      await act(async () => mounted.unmount());
    }
  });

  test('renders presets and an empty pool list from the server state', async () => {
    const { dom, cleanup } = await renderSection();
    try {
      const text = dom.container.textContent ?? '';
      expect(text).toContain('Model pools');
      expect(text).toContain('Cheapest first');
      expect(text).toContain('Fastest first');
      expect(text).toContain('Sturdiest first');
      expect(routeFetches.length).toBe(1);
    } finally {
      await cleanup();
    }
  });

  test('a preset builds a pool from the catalog and saves it', async () => {
    const { dom, cleanup } = await renderSection();
    try {
      await clickButton(dom.container, 'Cheapest first');
      expect(routeSaves).toEqual([{ 'cheap-pool': { targets: ['p/cheap', 'p/ dear'], autonomy: 'rules', selection: 'ordered' } }]);
      expect(dom.container.textContent).toContain('cheap-pool');
    } finally {
      await cleanup();
    }
  });

  test('a failed save rolls back to the last server-confirmed state', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    saveError = 'nope';
    const { dom, cleanup } = await renderSection();
    try {
      await clickButton(dom.container, 'Cheapest first');
      const text = dom.container.textContent ?? '';
      expect(text).toContain('kept');
      expect(text).not.toContain('cheap-pool');
      expect(text).toContain('nope');
    } finally {
      await cleanup();
    }
  });

  test('advanced editor saves a changed attempts count when the field is left', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await openAdvanced(dom.container);
      await typeInto(findInput(dom.container, 'Total requests before failover'), '3');
      expect(routeSaves).toEqual([{ kept: { targets: ['p/cheap'], attempts: 3 } }]);
    } finally {
      await cleanup();
    }
  });

  test('advanced editor refuses an out-of-range value and saves nothing', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await openAdvanced(dom.container);
      await typeInto(findInput(dom.container, 'Total requests before failover'), '99');
      expect(routeSaves.length).toBe(0);
      expect(dom.container.textContent).toContain('Enter a number from 1 to 50.');
    } finally {
      await cleanup();
    }
  });

  test('advanced editor converts hedge seconds to milliseconds', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await openAdvanced(dom.container);
      await typeInto(findInput(dom.container, 'Hedge after (seconds)'), '2');
      expect(routeSaves[0]).toEqual({ kept: { targets: ['p/cheap'], hedgeAfterMs: 2000 } });
    } finally {
      await cleanup();
    }
  });

  test('advanced editor saves per-target budgets with the soft limit as a fraction', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await openAdvanced(dom.container);
      await typeInto(findInput(dom.container, 'Requests per minute'), '60');
      await typeInto(findInput(dom.container, 'Soft limit (% of allowance)'), '80');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'], budgets: { 'p/cheap': { requestsPerMinute: 60, softLimit: 0.8 } } } });
    } finally {
      await cleanup();
    }
  });

  test('display name saves when left and an empty name removes it', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await expandPool(dom.container);
      await typeInto(findInput(dom.container, 'Display name'), 'Budget pool');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'], name: 'Budget pool' } });
      await typeInto(findInput(dom.container, 'Display name'), '');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'] } });
    } finally {
      await cleanup();
    }
  });

  test('a target remap saves as a variants map on the object form', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await expandPool(dom.container);
      await clickButton(dom.container, 'Options');
      await typeInto(findInput(dom.container, 'Default variant'), 'max');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: [{ model: 'p/cheap', defaultVariant: 'max' }] } });
      await typeInto(findInput(dom.container, 'Pool variant'), 'low');
      await typeInto(findInput(dom.container, 'Target variant'), 'high');
      await clickButton(dom.container, 'Add remap');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: [{ model: 'p/cheap', defaultVariant: 'max', variants: { low: 'high' } }] } });
    } finally {
      await cleanup();
    }
  });

  test('removing a weighted target saves the pool without that target\'s weight', async () => {
    serverRoutes = { kept: { targets: ['p/cheap', 'p/dear'], selection: 'weighted', weights: { 'p/cheap': 2, 'p/dear': 1 } } };
    const { dom, cleanup } = await renderSection();
    try {
      await expandPool(dom.container);
      await clickButton(dom.container, 'Remove target');
      expect(routeSaves.at(-1)).toEqual({
        kept: { targets: ['p/dear'], selection: 'weighted', weights: { 'p/dear': 1 } },
      });
    } finally {
      await cleanup();
    }
  });

  test('disabling the first-token timeout saves false and re-enabling removes it', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await openAdvanced(dom.container);
      await act(async () => findSwitch(dom.container, 'Never time out the first token').click());
      await settle();
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'], health: { firstTokenTimeoutMs: false } } });
      await act(async () => findSwitch(dom.container, 'Never time out the first token').click());
      await settle();
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'] } });
    } finally {
      await cleanup();
    }
  });

  test('the autonomy popup saves the level picked, and its default clears the level', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'], autonomy: 'rules' } };
    const { dom, cleanup } = await renderSection();
    try {
      await expandPool(dom.container);
      await pickOption(dom.container, 'Autonomy', 'Predictive');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'], autonomy: 'predictive' } });
      // The default leaves `autonomy: undefined` behind, which the JSON save drops.
      await pickOption(dom.container, 'Autonomy', 'Unset (full behavior)');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'] } });
    } finally {
      await cleanup();
    }
  });

  test('automatic review switch saves enabled and then explicitly disabled', async () => {
    const { dom, cleanup } = await renderSection();
    try {
      await act(async () => findSwitch(dom.container, 'Review routing history automatically').click());
      await settle();
      expect(tuningSaves).toEqual([{ enabled: true }]);
      await act(async () => findSwitch(dom.container, 'Review routing history automatically').click());
      await settle();
      expect(tuningSaves.at(-1)).toEqual({ enabled: false });
    } finally {
      await cleanup();
    }
  });

  test('automatic review interval is range checked before saving', async () => {
    const { dom, cleanup } = await renderSection();
    try {
      await typeInto(findInput(dom.container, 'Minutes between reviews'), '5000');
      expect(tuningSaves.length).toBe(0);
      expect(dom.container.textContent).toContain('Enter a number from 1 to 1440.');
      await typeInto(findInput(dom.container, 'Minutes between reviews'), '30');
      expect(tuningSaves.at(-1)).toEqual({ intervalMinutes: 30 });
    } finally {
      await cleanup();
    }
  });

  test('recent Auto decisions render in the expert view', async () => {
    useRoutingStore.setState({
      decisions: {
        s1: { sessionId: 's1', at: 2, category: 'hard', confidence: 0.9, reason: 'routed', providerID: 'openai', modelID: 'x' },
      },
    } as never);
    const { dom, cleanup } = await renderSection();
    try {
      expect(dom.container.textContent).toContain('hard');
    } finally {
      await cleanup();
    }
  });

  test('a pool the editor cannot model is listed beside the others, edited only as JSON, and saved back untouched', async () => {
    const hand: Json = { targets: [{ providerID: 'openai', model: 'gpt-6', variant: 'high' }], note: 'kept by hand' };
    serverRoutes = { kept: { targets: ['p/cheap'] }, hand };
    const { dom, cleanup } = await renderSection();
    try {
      expect(dom.container.textContent).toContain('kept');
      expect(dom.container.textContent).toContain('hand');
      expect(dom.container.textContent).toContain('JSON only');
      await expandPool(dom.container, 'hand');
      expect(dom.container.textContent).toContain('The editor can\'t show targets[0].providerID, so this pool is edited as JSON.');
      expect(dom.container.querySelector('input[aria-label="Display name"]')).toBeNull();
      expect(findByAriaLabel(dom.container, 'textarea', 'Raw JSON (expert)')).toBeTruthy();
      await expandPool(dom.container, 'kept');
      await typeInto(findInput(dom.container, 'Display name'), 'Budget pool');
      expect(routeSaves.at(-1)).toEqual({ kept: { targets: ['p/cheap'], name: 'Budget pool' }, hand });
    } finally {
      await cleanup();
    }
  });

  test('applying JSON to a pool kept as JSON saves exactly what was typed', async () => {
    serverRoutes = { hand: { targets: ['p/cheap'], note: 'kept by hand' } };
    const { dom, cleanup } = await renderSection();
    try {
      await expandPool(dom.container, 'hand');
      const textarea = dom.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Raw JSON (expert)"]');
      if (!textarea) throw new Error('no JSON view');
      await editTextArea(textarea, '{"targets":["p/dear"],"note":"edited"}');
      await clickButton(dom.container, 'Apply JSON');
      expect(routeSaves.at(-1)).toEqual({ hand: { targets: ['p/dear'], note: 'edited' } });
    } finally {
      await cleanup();
    }
  });

  test('a pool\'s problems show on it, saying whether OpenCode skips the pool', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'], attempts: 0, weights: { 'x/y': 2 } } };
    serverProblems = {
      kept: [
        { message: 'route "kept" weight for "x/y" matches no target in the route', skipsPool: false },
        { message: 'route "kept" attempts must be a whole number from 1 to 50', skipsPool: true },
      ],
    };
    const { dom, cleanup } = await renderSection();
    try {
      const text = dom.container.textContent ?? '';
      expect(text).toContain('OpenCode loads this pool, but OpenChamber could not check it: route "kept" weight for "x/y" matches no target in the route');
      expect(text).toContain('OpenCode skips this pool: route "kept" attempts must be a whole number from 1 to 50');
    } finally {
      await cleanup();
    }
  });

  test('a refused save names the problems, and Save anyway sends the same pools again with force', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    refusal = { 'cheap-pool': [{ message: 'route "cheap-pool" health.slowThreshold (6) cannot exceed health.sampleWindow (5)', skipsPool: false }] };
    const { dom, cleanup } = await renderSection();
    try {
      await clickButton(dom.container, 'Cheapest first');
      let text = dom.container.textContent ?? '';
      expect(text).toContain('Not saved. Fix these problems, or save anyway.');
      expect(text).toContain('OpenCode loads this pool, but OpenChamber could not check it: route "cheap-pool" health.slowThreshold (6)');
      // The list rolls back to what the server holds.
      expect([...dom.container.querySelectorAll('button[aria-expanded]')].map((row) => row.textContent)).toEqual(['kept1 targets']);
      await clickButton(dom.container, 'Save anyway');
      expect(forcedSaves).toEqual([false, true]);
      expect(routeSaves[1]).toEqual(routeSaves[0]);
      text = dom.container.textContent ?? '';
      expect(text).not.toContain('Not saved.');
      expect(text).toContain('cheap-pool');
    } finally {
      await cleanup();
    }
  });

  test('review settings OpenChamber cannot read leave the pools loaded and are not offered for editing', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    serverTuning = { enabled: 'yes', notes: ['openai: back in 3 hours'] };
    const { dom, cleanup } = await renderSection();
    try {
      expect(dom.container.textContent).toContain('kept');
      expect(dom.container.textContent).toContain('OpenChamber can\'t read these settings. Edit them in your OpenCode config file.');
      expect(dom.container.querySelector('[role="switch"][aria-label="Review routing history automatically"]')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test('a pool that picks its models by pattern shows its rules in words, opens in the editor, and keeps them through an edit', async () => {
    const small = {
      include: ['*luna*', '*haiku*'],
      exclude: ['*-5'],
      contains: ['flash'],
      notContains: ['preview'],
      match: '*luna* and not *mini*',
      levels: ['low', 'medium', 'high'],
      variantRules: [{ match: '*argon*', map: { xhigh: 'high', max: false } }],
      autonomy: 'rules',
    };
    const kept = { targets: ['p/cheap'], exclude: ['*-5'], levels: [] };
    serverRoutes = { small, kept };
    const { dom, cleanup } = await renderSection();
    try {
      const rows = () => [...dom.container.querySelectorAll('button[aria-expanded]')].map((row) => row.textContent);
      expect(rows()).toEqual([
        'smallIncludes *luna*, *haiku* · Excludes *-5 · Includes models whose id contains flash · Excludes models whose id contains preview'
          + ' · Includes models matching *luna* and not *mini* · Offers levels low, medium, high · rules',
        'kept1 targets · Excludes *-5 · Offers no levels',
      ]);
      expect(dom.container.textContent).not.toContain('JSON only');
      await expandPool(dom.container, 'small');
      const text = dom.container.textContent ?? '';
      expect(text).toContain('Patterns and levels');
      expect(text).toContain('Levels for *argon*: xhigh → high, sits out max');
      expect(text).toContain('To change these rules, edit the pool in Raw JSON.');
      await typeInto(findInput(dom.container, 'Display name'), 'Small models');
      expect(routeSaves).toEqual([{ small: { ...small, name: 'Small models' }, kept }]);
    } finally {
      await cleanup();
    }
  });

  test('a new pool stays a draft until it has a target or a pattern, and then saves', async () => {
    const { dom, cleanup } = await renderSection();
    try {
      const idInput = findInput(dom.container, 'Add pool');
      // A controlled input takes an edit the way React reads one: the native setter, then an input event.
      const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(idInput), 'value')?.set;
      await act(async () => {
        setValue?.call(idInput, 'fresh');
        idInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await clickButton(dom.container, 'Add');
      const applyJson = async (text: string) => {
        const textarea = dom.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Raw JSON (expert)"]');
        if (!textarea) throw new Error('no JSON view');
        await editTextArea(textarea, text);
        await clickButton(dom.container, 'Apply JSON');
      };
      await applyJson('{"targets":[],"exclude":["*-mini"],"levels":["low"]}');
      expect(routeSaves).toEqual([]);
      await applyJson('{"include":["*luna*"],"exclude":["*-mini"]}');
      expect(routeSaves).toEqual([{ fresh: { include: ['*luna*'], exclude: ['*-mini'] } }]);
    } finally {
      await cleanup();
    }
  });

  // happy-dom lays nothing out, so the three tests below pin the classes that decide what gives way on a narrow pane.
  test('a pool row keeps its name whole and truncates the rule summary first', async () => {
    serverRoutes = { small: { name: 'Luna and Haiku', include: ['*luna*', '*haiku*'], exclude: ['*-5'] } };
    const { dom, cleanup } = await renderSection();
    try {
      const row = [...dom.container.querySelectorAll('button[aria-expanded]')].find((el) => el.textContent?.startsWith('Luna and Haiku'));
      if (!row) throw new Error('no row for the pool');
      const [name, summary] = [...row.children];
      expect(name.textContent).toBe('Luna and Haiku');
      expect(summary.textContent).toBe('Includes *luna*, *haiku* · Excludes *-5');
      // The name does not shrink, and is capped at the row so a name too long for it still truncates.
      expect(missingClasses(name, ['shrink-0', 'max-w-full', 'truncate'])).toEqual([]);
      expect(summary.classList.contains('shrink-0')).toBe(false);
      expect(summary.classList.contains('truncate')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test('a target name wraps on a line of its own below the @xl width, so targets of one provider read apart', async () => {
    serverRoutes = { kept: { targets: ['fake/fake-model', 'fake/fake-model-2'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await expandPool(dom.container);
      const names = [...dom.container.querySelectorAll('span')].filter((el) => el.textContent?.startsWith('fake/'));
      expect(names.map((el) => el.textContent)).toEqual(['fake/fake-model', 'fake/fake-model-2']);
      for (const name of names) {
        expect(name.classList.contains('truncate')).toBe(false);
        expect(missingClasses(name, ['break-words', 'basis-full', '@xl:basis-0'])).toEqual([]);
        // The wait estimate and Remove target move to the next line instead of narrowing the name.
        expect(name.parentElement?.classList.contains('flex-wrap')).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  test('the pattern field takes a line of its own below the @xl width, so the date field cannot squeeze it', async () => {
    serverRoutes = { kept: { targets: ['p/cheap'] } };
    const { dom, cleanup } = await renderSection();
    try {
      await expandPool(dom.container);
      const pattern = findInput(dom.container, 'Add by pattern');
      const until = findInput(dom.container, 'Expires');
      expect(until.parentElement).toBe(pattern.parentElement);
      expect(pattern.parentElement?.classList.contains('flex-wrap')).toBe(true);
      expect(missingClasses(pattern, ['grow', 'basis-full', '@xl:basis-0'])).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
