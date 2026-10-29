import { describe, expect, it, vi } from 'vitest';

import { fetchWithDeadline } from './bounded-fetch.js';

// A fetch whose response never arrives; like a real fetch it rejects when
// the request signal aborts.
const stalledFetch = () =>
  vi.fn(
    async (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }),
  );

describe('fetchWithDeadline', () => {
  it('rejects with a TimeoutError at the deadline', async () => {
    await expect(fetchWithDeadline(stalledFetch(), 'https://example.test', {}, { timeoutMs: 30 })).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('rejects with the caller signal reason when the caller aborts first', async () => {
    const caller = new AbortController();
    const pending = fetchWithDeadline(stalledFetch(), 'https://example.test', {}, { timeoutMs: 60_000, signal: caller.signal });
    caller.abort(new Error('caller gave up'));
    await expect(pending).rejects.toThrow('caller gave up');
  });

  it('keeps the caller signal out of init: the composed signal replaces nothing', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'));
    const caller = new AbortController();
    await fetchWithDeadline(fetchImpl, 'https://example.test', { signal: undefined }, { timeoutMs: 1000, signal: caller.signal });
    const passed = fetchImpl.mock.calls[0][1].signal;
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed).not.toBe(caller.signal);
  });

  it('headersOnly clears the deadline once headers arrive: the body stays readable', async () => {
    const fetchImpl = vi.fn(async () => new Response('body-text'));
    const response = await fetchWithDeadline(fetchImpl, 'https://example.test', {}, { timeoutMs: 30, headersOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(response.text()).resolves.toBe('body-text');
  });

  it('by default the deadline bounds the body read: a silent body settles at the deadline', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Headers arrived; the body never produces a byte.
            },
          }),
        ),
    );
    const response = await fetchWithDeadline(fetchImpl, 'https://example.test', {}, { timeoutMs: 30 });
    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('returns an under-deadline body unchanged', async () => {
    const fetchImpl = vi.fn(async () => new Response('complete'));
    const response = await fetchWithDeadline(fetchImpl, 'https://example.test', {}, { timeoutMs: 1000 });
    await expect(response.text()).resolves.toBe('complete');
  });

  it('requires a positive timeoutMs', async () => {
    await expect(fetchWithDeadline(stalledFetch(), 'https://example.test', {}, {})).rejects.toThrow(TypeError);
  });
});
