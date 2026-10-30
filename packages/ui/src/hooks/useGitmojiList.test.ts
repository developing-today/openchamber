import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { fetchGitmojiList, GITMOJI_FETCH_TIMEOUT_MS } from './useGitmojiList';

const ENTRY = { emoji: '✨', code: ':sparkles:', description: 'Introduce new features.' };

let originalFetch: typeof globalThis.fetch;
let originalWarn: typeof console.warn;

beforeEach(() => {
  jest.useFakeTimers();
  originalFetch = globalThis.fetch;
  originalWarn = console.warn;
  console.warn = () => {};
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

const successFetch = async (): Promise<Response> => new Response(JSON.stringify({ gitmojis: [ENTRY] }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

test('a stalled catalog fetch settles via the failure path at the deadline and a later call re-fetches', async () => {
  let fetchCalls = 0;
  const signals: Array<AbortSignal | null | undefined> = [];
  const stalledFetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchCalls += 1;
    signals.push(init?.signal);
    // A request that never answers, but like a real fetch it rejects when
    // its signal aborts.
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  };
  globalThis.fetch = Object.assign(stalledFetch, originalFetch);

  const first = fetchGitmojiList();
  const second = fetchGitmojiList();
  expect(fetchCalls).toBe(1);
  expect(signals[0]).toBeInstanceOf(AbortSignal);

  jest.advanceTimersByTime(GITMOJI_FETCH_TIMEOUT_MS);
  expect(await first).toEqual([]);
  expect(await second).toEqual([]);

  globalThis.fetch = Object.assign(successFetch, originalFetch);
  expect(await fetchGitmojiList()).toEqual([ENTRY]);
  expect(fetchCalls).toBe(1);
});

test('a stalled body read also settles via the failure path at the deadline', async () => {
  let fetchCalls = 0;
  const stalledBodyFetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchCalls += 1;
    // Headers arrive at once; the body stream never produces a byte and
    // errors when the fetch signal aborts, as a real response body does.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) {
          controller.error(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => controller.error(signal.reason));
      },
    });
    return Promise.resolve(new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  };
  globalThis.fetch = Object.assign(stalledBodyFetch, originalFetch);

  const pending = fetchGitmojiList();
  // Let the loader reach the body read (and attach to the signal) first.
  await Promise.resolve();
  await Promise.resolve();
  jest.advanceTimersByTime(GITMOJI_FETCH_TIMEOUT_MS);
  expect(await pending).toEqual([]);
  expect(fetchCalls).toBe(1);

  globalThis.fetch = Object.assign(successFetch, originalFetch);
  expect(await fetchGitmojiList()).toEqual([ENTRY]);
});
