import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import { useRoutingStore } from '@/stores/useRoutingStore';
import { useUIStore } from '@/stores/useUIStore';

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

// The control stream is an EventSource. The fake records each one so a test can send it a server envelope.
type FakeSource = { url: string; readyState: number; onmessage: ((event: { data: string }) => void) | null };
const sources: FakeSource[] = [];

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    sources.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

const routingState = {
  available: true,
  autoReady: true,
  jevAvailable: true,
  tokenPresent: true,
  jevSource: 'typesafe',
  config: null,
  builtins: [],
};

// Sends one server envelope down the control stream, as the server would.
const emit = async (envelope: string) => {
  await act(async () => {
    sources.at(-1)?.onmessage?.({ data: envelope });
  });
};

describe('useRoutingSync', () => {
  let root: Root | null = null;
  let restore: (() => void) | null = null;
  let previousEventSource: PropertyDescriptor | undefined;
  let routingReads = 0;

  beforeEach(() => {
    sources.length = 0;
    routingReads = 0;
    previousEventSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
    Object.defineProperty(globalThis, 'EventSource', { value: FakeEventSource, configurable: true, writable: true });
    spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) !== '/api/routing') return new Response('', { status: 404 });
      routingReads += 1;
      return new Response(JSON.stringify(routingState), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    useRoutingStore.setState({ decisions: {} });
    useUIStore.setState({ routingFeatureAvailable: false });
  });

  afterEach(async () => {
    mock.restore();
    useUIStore.setState({ routingFeatureAvailable: false });
    if (root) {
      const mounted = root;
      root = null;
      await act(async () => mounted.unmount());
    }
    restore?.();
    restore = null;
    if (previousEventSource) Object.defineProperty(globalThis, 'EventSource', previousEventSource);
    else Reflect.deleteProperty(globalThis, 'EventSource');
  });

  const mountHook = async () => {
    const dom = installDom();
    restore = dom.restore;
    // Imported after the DOM exists, as the other routing component tests do.
    const { createRoot } = await import('react-dom/client');
    const { useRoutingSync } = await import('./useRoutingSync');
    const { I18nProvider } = await import('@/lib/i18n');
    const Probe = () => {
      useRoutingSync();
      return null;
    };
    root = createRoot(dom.container);
    await act(async () => {
      root?.render(
        <I18nProvider>
          <Probe />
        </I18nProvider>,
      );
    });
  };

  test('reads the routing state once when the feature is available, and opens the control stream', async () => {
    useUIStore.setState({ routingFeatureAvailable: true });
    await mountHook();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(routingReads).toBe(1);
    expect(sources.at(-1)?.url).toContain('/api/openchamber/events');
  });

  test('applies a routing-updated event to the store and re-reads the configuration behind it', async () => {
    useUIStore.setState({ routingFeatureAvailable: true });
    await mountHook();
    await emit(JSON.stringify({
      type: 'openchamber:routing.updated',
      properties: { available: true, autoReady: true, jevAvailable: true, tokenPresent: true, jevSource: 'typesafe' },
    }));
    expect(useRoutingStore.getState()).toMatchObject({ available: true, autoReady: true, jevAvailable: true, tokenPresent: true });
    expect(routingReads).toBeGreaterThanOrEqual(2);
  });

  test('records a routing decision under its session', async () => {
    useUIStore.setState({ routingFeatureAvailable: true });
    await mountHook();
    await emit(JSON.stringify({
      type: 'openchamber:routing.decision',
      properties: { sessionId: 'ses_1', at: 1, category: 'hard', confidence: 0.9, reason: 'routed', providerID: 'openai', modelID: 'gpt-6-astra' },
    }));
    expect(useRoutingStore.getState().decisions.ses_1).toMatchObject({ category: 'hard', reason: 'routed', modelID: 'gpt-6-astra' });
  });

  test('ignores every routing event while the feature is unavailable, and opens no stream', async () => {
    await mountHook();
    expect(routingReads).toBe(0);
    expect(sources).toHaveLength(0);
  });
});
