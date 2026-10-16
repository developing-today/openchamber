import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionOrderingStore } from '@/sync/session-ordering';
import { holdOpenSessionForDone, releaseOpenSession, useOpenSessionHoldTracking, useOpenSessionOverride } from './openSessionHold';
import type { SidebarSessionZoneKey } from './sidebarZones';

// SAFETY: the hold reads only the id, directory and lifecycle times of these fixtures.
const session = (id: string): Session => ({ id, title: id, directory: '/repo', time: { created: 10, updated: 20 } } as Session);
const sessions = new Map([['a', session('a')], ['b', session('b')]]);

type Inputs = Parameters<typeof useOpenSessionHoldTracking>[0];
const inputs = (enabled: boolean, zones: Record<string, SidebarSessionZoneKey>): Inputs => ({
  enabled,
  sessionById: sessions,
  naturalZoneBySessionId: new Map(Object.entries(zones)),
  pinnedSessionIds: new Set(),
});

let latestOverride: ReturnType<typeof useOpenSessionOverride> = null;
function Harness({ value }: { value: Inputs }): null {
  useOpenSessionHoldTracking(value);
  latestOverride = useOpenSessionOverride();
  return null;
}

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useSessionUIStore.setState({ currentSessionId: 'a' });
  useSessionOrderingStore.setState({ rankById: new Map() });
  latestOverride = null;
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  useSessionUIStore.setState({ currentSessionId: null });
});

const render = (value: Inputs) => act(async () => root.render(<Harness value={value} />));

describe('open session hold', () => {
  test('keeps the open session in its zone and at its rank until another session opens', async () => {
    await render(inputs(true, { a: 'work' }));
    expect(latestOverride).toBeNull();

    await render(inputs(true, { a: 'questions' }));
    expect(latestOverride).toEqual({ sessionId: 'a', zone: 'work' });

    await act(async () => useSessionOrderingStore.setState({ rankById: new Map([['a', 99_999]]) }));
    expect(latestOverride?.zone).toBe('work');
    expect(latestOverride?.rank).toBe(20);

    await act(async () => useSessionUIStore.setState({ currentSessionId: 'b' }));
    expect(latestOverride).toBeNull();
  });

  test('without the general hold, Done can still hold the row until the session changes', async () => {
    await render(inputs(false, { a: 'work' }));
    await render(inputs(false, {}));
    expect(latestOverride).toBeNull();

    await render(inputs(false, { a: 'work' }));
    await act(async () => holdOpenSessionForDone('a'));
    await render(inputs(false, {}));
    expect(latestOverride).toEqual({ sessionId: 'a', zone: 'work' });

    await act(async () => useSessionUIStore.setState({ currentSessionId: 'b' }));
    expect(latestOverride).toBeNull();
  });

  test('a released session moves at once, and undoing the release holds it again', async () => {
    await render(inputs(true, { a: 'work' }));
    let restore: () => void = () => undefined;
    await act(async () => { restore = releaseOpenSession('a'); });
    await render(inputs(true, {}));
    expect(latestOverride).toBeNull();

    await act(async () => restore());
    expect(latestOverride).toEqual({ sessionId: 'a', zone: 'work' });
  });
});
