import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

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

type Sent = { url: string; method: string; body: string };

const sent: Sent[] = [];
let respond: (request: Sent) => Response = () => new Response('', { status: 500 });

const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

const SETTINGS = {
  stages: { keywords: true, local: true, external: true },
  learnAfter: 3,
  waitPercentile: 25,
  waitMinSamples: 5,
};

const LOCAL = {
  label: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
  bytes: 1117320736,
  installed: false,
  downloadedBytes: 0,
  downloading: false,
  error: null,
};

let mounted: { root: Root; restore: () => void } | null = null;

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const renderAdvanced = async () => {
  const dom = installDom();
  // Imported after the DOM exists: react-dom decides at load time whether input events are native.
  const { createRoot } = await import('react-dom/client');
  const { RouteRulesAdvanced } = await import('./RouteRulesAdvanced');
  const { I18nProvider } = await import('@/lib/i18n');
  const root = createRoot(dom.container);
  mounted = { root, restore: dom.restore };
  await act(async () => {
    root.render(
      <I18nProvider>
        <RouteRulesAdvanced />
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

// A controlled field saves when React reads a change: the value goes in through the native setter (so
// React's tracked value does not hide it), then an input event follows.
const changeValue = async (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const putBodies = () => sent.filter((request) => request.method === 'PUT').map((request) => JSON.parse(request.body));

describe('RouteRulesAdvanced', () => {
  beforeEach(() => {
    sent.length = 0;
    spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request: Sent = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? String(init.body) : '' };
      sent.push(request);
      return respond(request);
    });
    respond = (request) => {
      if (request.url === '/api/model-routes/settings' && request.method === 'PUT') return reply(request.body);
      if (request.url === '/api/model-routes/settings') return reply(JSON.stringify(SETTINGS));
      if (request.url === '/api/model-routes/local') return reply(JSON.stringify(LOCAL));
      return new Response('', { status: 404 });
    };
  });

  afterEach(async () => {
    mock.restore();
    if (!mounted) return;
    const current = mounted;
    mounted = null;
    await act(async () => current.root.unmount());
    current.restore();
  });

  test('saves the interpretation stage that was switched off, with the others unchanged', async () => {
    const container = await renderAdvanced();
    await act(async () => buttonWith(container, 'Show advanced').click());
    await settle();
    const keywords = container.querySelector<HTMLElement>('[role="switch"]');
    if (!keywords) throw new Error('no stage switch');
    await act(async () => keywords.click());
    // happy-dom also runs the enclosing label's activation for the switch, which toggles it a second
    // time; the switch's own save is the first PUT.
    expect(putBodies()[0]).toEqual({ ...SETTINGS, stages: { keywords: false, local: true, external: true } });
  });

  test('saves a changed learning threshold as typed', async () => {
    const container = await renderAdvanced();
    await act(async () => buttonWith(container, 'Show advanced').click());
    await settle();
    await changeValue(inputNamed(container, 'Learn after'), '6');
    expect(putBodies().at(-1)).toEqual({ ...SETTINGS, learnAfter: 6 });
  });

  test('shows the reason the local model download was refused, and sends the download request once', async () => {
    respond = (request) => {
      if (request.url === '/api/model-routes/settings') return reply(JSON.stringify(SETTINGS));
      if (request.url === '/api/model-routes/local/download') {
        return reply(JSON.stringify({ error: 'No checksum is pinned for the local model in this build, so it cannot be downloaded safely' }), 409);
      }
      return reply(JSON.stringify(LOCAL));
    };
    const container = await renderAdvanced();
    await act(async () => buttonWith(container, 'Show advanced').click());
    await settle();
    await act(async () => buttonWith(container, 'Download').click());
    await settle();
    expect(sent.filter((request) => request.url === '/api/model-routes/local/download')).toHaveLength(1);
    expect(container.textContent).toContain('No checksum is pinned for the local model in this build');
  });
});
