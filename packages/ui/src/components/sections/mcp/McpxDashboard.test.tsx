import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  PointerEvent: browser.PointerEvent, MouseEvent: browser.MouseEvent, KeyboardEvent: browser.KeyboardEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { McpxDashboard, MCPX_DASHBOARD_FETCH_TIMEOUT_MS } = await import('./McpxDashboard');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  await act(async () => { root.render(null); });
});

const flush = async (ms = 0) => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
};

const refreshButton = (): HTMLButtonElement => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => entry.textContent?.includes('Refresh'));
  if (!button) throw new Error('Missing Refresh button');
  return button;
};

const viewTypesButtons = (): HTMLButtonElement[] => {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .filter((entry) => entry.textContent === 'View Types');
  if (buttons.length === 0) throw new Error('Missing View Types buttons');
  return buttons;
};

interface TypesPanel {
  heading: string;
  body: string;
}

const readTypesPanel = (): TypesPanel => ({
  heading: container.querySelector('h3')?.textContent ?? '',
  body: container.querySelector('pre')?.textContent ?? '',
});

test('every dashboard fetch carries a deadline', async () => {
  expect(MCPX_DASHBOARD_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
  const seenSignals: Array<AbortSignal | null | undefined> = [];
  const stubFetch: typeof fetch = (input, init) => {
    seenSignals.push(init?.signal);
    const url = input.toString();
    if (url.includes('/api/mcpx/types')) return Promise.resolve(Response.json({ types: 'TYPES-BODY' }));
    if (url.includes('/api/mcpx/namespaces')) {
      return Promise.resolve(Response.json([{ namespace: 'alpha', tools: 1 }]));
    }
    return Promise.resolve(Response.json({ daemon: { running: true, pid: 1 } }));
  };
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(stubFetch);
  try {
    await act(async () => { root.render(<I18nProvider><McpxDashboard /></I18nProvider>); });
    await flush();
    const [viewTypes] = viewTypesButtons();
    await act(async () => { viewTypes.click(); });
    await flush();
    expect(seenSignals.length).toBe(3);
    for (const signal of seenSignals) expect(signal).toBeInstanceOf(AbortSignal);
  } finally {
    fetchSpy.mockRestore();
  }
});

test('a stalled status load reaches the error state and leaves Refresh usable', async () => {
  // Shorten the production deadline for the test; the stub below honours the
  // signal exactly like a real fetch (rejects when it aborts).
  AbortSignal.timeout = (delay: number) => originalTimeout(Math.min(delay, 20));
  const stubFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(stubFetch);
  try {
    await act(async () => { root.render(<I18nProvider><McpxDashboard /></I18nProvider>); });
    // Loading disables Refresh while the load is in flight.
    expect(refreshButton().disabled).toBe(true);
    await flush(100);
    // The deadline fired: the error state shows and Refresh works again.
    expect(container.textContent).not.toContain('Daemon Online');
    expect(refreshButton().disabled).toBe(false);
  } finally {
    fetchSpy.mockRestore();
  }
});

test('a slow superseded types response never overwrites the current namespace', async () => {
  let resolveAlpha!: (response: Response) => void;
  const alphaPromise = new Promise<Response>((resolve) => { resolveAlpha = resolve; });
  const stubFetch: typeof fetch = (input) => {
    const url = input.toString();
    if (url.includes('/api/mcpx/types?namespace=alpha')) return alphaPromise;
    if (url.includes('/api/mcpx/types?namespace=beta')) return Promise.resolve(Response.json({ types: 'BETA-TYPES' }));
    if (url.includes('/api/mcpx/namespaces')) {
      return Promise.resolve(Response.json([{ namespace: 'alpha' }, { namespace: 'beta' }]));
    }
    return Promise.resolve(Response.json({ daemon: { running: true, pid: 1 } }));
  };
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(stubFetch);
  try {
    await act(async () => { root.render(<I18nProvider><McpxDashboard /></I18nProvider>); });
    await flush();
    const [viewAlpha, viewBeta] = viewTypesButtons();
    await act(async () => { viewAlpha.click(); });
    await act(async () => { viewBeta.click(); });
    await flush();
    // The fast beta load wins immediately.
    expect(readTypesPanel().heading).toContain('beta');
    expect(readTypesPanel().body).toContain('BETA-TYPES');
    // The slow alpha load resolves after it was superseded: dropped.
    await act(async () => { resolveAlpha(Response.json({ types: 'ALPHA-TYPES' })); });
    await flush();
    expect(readTypesPanel().heading).toContain('beta');
    expect(readTypesPanel().body).toContain('BETA-TYPES');
    expect(readTypesPanel().body).not.toContain('ALPHA-TYPES');
  } finally {
    fetchSpy.mockRestore();
    resolveAlpha(Response.json({ types: 'ALPHA-TYPES' }));
  }
});
