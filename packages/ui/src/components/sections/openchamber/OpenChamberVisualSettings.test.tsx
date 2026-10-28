import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

import { OpenChamberVisualSettings } from './OpenChamberVisualSettings';

// SAFETY: This render path only reads the optional terminal methods, so no other runtime API can be called.
const runtimeAPIs = { terminal: {} } as RuntimeAPIs;

describe('OpenChamberVisualSettings', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let initialAnimatedActivityIndicators: boolean;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;

  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'];

  beforeEach(() => {
    windowInstance = new Window();
    initialAnimatedActivityIndicators = useSessionDisplayStore.getState().animatedActivityIndicators;
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      localStorage: windowInstance.localStorage,
      sessionStorage: windowInstance.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      useSessionDisplayStore.setState({ animatedActivityIndicators: initialAnimatedActivityIndicators });
      useSessionDisplayStore.getState().setSessionRowDisplay({ zoneLines: 'one' });
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  test('renders session activity when it is the only visible setting', async () => {
    await act(async () => root.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <ThemeSystemProvider>
          <I18nProvider>
            <OpenChamberVisualSettings visibleSettings={['animatedActivityIndicators']} />
          </I18nProvider>
        </ThemeSystemProvider>
      </RuntimeAPIContext.Provider>,
    ));

    expect(host.querySelector('[data-settings-item="appearance.session-activity"]')).not.toBeNull();
  });

  test('renders the sidebar rows section with a live preview row', async () => {
    await act(async () => root.render(
      <RuntimeAPIContext.Provider value={runtimeAPIs}>
        <ThemeSystemProvider>
          <I18nProvider>
            <OpenChamberVisualSettings visibleSettings={['sidebarRows']} />
          </I18nProvider>
        </ThemeSystemProvider>
      </RuntimeAPIContext.Provider>,
    ));

    expect(host.querySelector('[data-settings-item="appearance.sidebar-rows"]')).not.toBeNull();
    expect(host.querySelector('[data-settings-item="appearance.sidebar-rows-lines"]')).not.toBeNull();
    const branchRow = host.querySelector('[data-settings-item="appearance.sidebar-rows-branch"]');
    expect(branchRow?.getAttribute('aria-pressed')).toBe('true');
    // One line by default: the title and time show, the branch has no slot.
    const section = host.querySelector('[data-settings-item="appearance.sidebar-rows"]');
    expect(section?.textContent).toContain('Design the empty states');
    expect(section?.textContent).not.toContain('feature/rows');
    await act(async () => {
      useSessionDisplayStore.getState().setSessionRowDisplay({ zoneLines: 'two' });
    });
    // Two lines: the branch gets its slot back.
    expect(host.querySelector('[data-settings-item="appearance.sidebar-rows"]')?.textContent).toContain('feature/rows');
  });
});
