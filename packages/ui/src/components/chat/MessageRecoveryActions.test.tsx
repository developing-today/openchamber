import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Message } from '@/lib/opencode/model';

const targets: Array<{ providerID: string; id: string }> = [];
const providers = () => [{
  id: 'opencode-route',
  models: [{
    id: 'pool',
    settings: { opencodeRoute: { targets } },
  }],
}];
// SAFETY: test fixture provides the subset of message properties used by recovery.
const messages = [{
  id: 'user-1',
  sessionID: 'session-1',
  role: 'user',
  time: { created: 1 },
}] as Message[];

mock.module('@/components/ui', () => ({ toast: { error: () => undefined } }));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/sections/agents/ModelSelector', () => ({
  ModelSelector: ({ placeholder }: { placeholder: string }) => <button type="button">{placeholder}</button>,
}));
mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => ({
    'chat.sessionErrorRecovery.chooseModel': 'Choose a model',
    'chat.sessionErrorRecovery.nextPoolTarget': 'Next pool target',
    'chat.sessionErrorRecovery.noNextPoolTarget': 'No next pool target',
    'chat.sessionErrorRecovery.retrying': 'Retrying',
    'chat.sessionErrorRecovery.failed': 'Retry failed',
  }[key] ?? key) }),
}));
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: <T,>(select: (state: { providers: ReturnType<typeof providers>; currentProviderId: string; currentModelId: string }) => T): T => (
    select({ providers: providers(), currentProviderId: '', currentModelId: '' })
  ),
  selectProvidersForDirectory: (state: { providers: ReturnType<typeof providers> }) => state.providers,
}));
mock.module('@/sync/selection-store', () => ({
  useSelectionStore: <T,>(select: (state: { sessionModelSelections: Map<string, unknown> }) => T): T => (
    select({ sessionModelSelections: new Map() })
  ),
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: <T,>(select: (state: { currentSessionId: string }) => T): T => select({ currentSessionId: 'session-1' }),
}));
mock.module('@/sync/sync-context', () => ({
  useSessionMessages: () => messages,
  useSession: () => ({ id: 'session-1', model: { providerID: 'opencode-route', id: 'pool' } }),
  useSessionStatus: () => ({ type: 'idle' }),
  useSessionStatusSnapshotReady: () => true,
}));

const { MessageRecoveryActions } = await import('./MessageRecoveryActions');

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
let previousGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  previousGlobals = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    container,
    render: async () => act(async () => root.render(<MessageRecoveryActions sessionId="session-1" />)),
    cleanup: async () => {
      await act(async () => root.unmount());
      for (const [name, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

beforeEach(() => {
  targets.splice(0, targets.length, { providerID: 'provider-a', id: 'model-a' });
});

describe('MessageRecoveryActions pool recovery', () => {
  test('shows the pool action, disabled, when there is no alternate target', async () => {
    const dom = installDom();
    try {
      await dom.render();
      const button = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button'))
        .find((candidate) => candidate.textContent?.trim() === 'Next pool target');

      expect(button).toBeDefined();
      expect(button?.disabled).toBe(true);
      expect(button?.title).toBe('No next pool target');
    } finally {
      await dom.cleanup();
    }
  });

  test('enables the pool action when another configured target is available', async () => {
    targets.push({ providerID: 'provider-b', id: 'model-b' });
    const dom = installDom();
    try {
      await dom.render();
      const button = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button'))
        .find((candidate) => candidate.textContent?.trim() === 'Next pool target');

      expect(button).toBeDefined();
      expect(button?.disabled).toBe(false);
      expect(button?.title).toBe('provider-b/model-b');
    } finally {
      await dom.cleanup();
    }
  });
});
