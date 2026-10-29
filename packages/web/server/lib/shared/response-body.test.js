import { describe, expect, it } from 'vitest';

import { readBoundedResponseBytes, readBoundedResponseText } from './response-body.js';

const streamOf = (chunks, { declaredLength } = {}) => {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const headers = new Headers();
  if (declaredLength !== undefined) headers.set('content-length', String(declaredLength));
  return new Response(stream, { headers });
};

describe('shared bounded response readers', () => {
  it('returns a complete body under the cap unchanged', async () => {
    await expect(readBoundedResponseText(streamOf(['hello ', 'world']), 100)).resolves.toEqual({
      tooLarge: false,
      text: 'hello world',
    });
    const bytes = await readBoundedResponseBytes(streamOf(['abc']), 100);
    expect(bytes.tooLarge).toBe(false);
    expect(bytes.bytes.toString('utf8')).toBe('abc');
  });

  it('refuses on the declared length before reading', async () => {
    let pulls = 0;
    const stream = new ReadableStream({
      pull() {
        pulls += 1;
      },
    });
    const response = new Response(stream, { headers: { 'content-length': '101' } });
    await expect(readBoundedResponseText(response, 100)).resolves.toEqual({ tooLarge: true });
    expect(pulls).toBe(0);
  });

  it('cancels mid-stream the moment the cap is crossed', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123456'));
        controller.enqueue(new TextEncoder().encode('78901'));
        // Never closed: only the reader cancelling can end this body.
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBoundedResponseText(new Response(stream), 10)).resolves.toEqual({ tooLarge: true });
    expect(cancelled).toBe(true);
  });
});
