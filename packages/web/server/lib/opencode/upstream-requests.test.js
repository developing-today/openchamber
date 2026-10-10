import { describe, expect, it } from 'vitest';

import { beginUpstreamRequest, countUpstreamRequests } from './upstream-requests.js';

describe('upstream request counting', () => {
  it('counts requests per port until each one ends', () => {
    const port = 41001;
    const endFirst = beginUpstreamRequest(port);
    const endSecond = beginUpstreamRequest(port);
    expect(countUpstreamRequests(port)).toBe(2);

    endFirst();
    expect(countUpstreamRequests(port)).toBe(1);

    endSecond();
    expect(countUpstreamRequests(port)).toBe(0);
  });

  it('ignores a second end call for the same request', () => {
    const port = 41002;
    const endA = beginUpstreamRequest(port);
    beginUpstreamRequest(port);

    endA();
    endA();
    expect(countUpstreamRequests(port)).toBe(1);
  });

  it('keeps ports separate', () => {
    const endOld = beginUpstreamRequest(41003);
    expect(countUpstreamRequests(41004)).toBe(0);
    endOld();
    expect(countUpstreamRequests(41003)).toBe(0);
  });

  it('ignores ports that are not usable upstreams', () => {
    const end = beginUpstreamRequest(0);
    expect(countUpstreamRequests(0)).toBe(0);
    expect(() => end()).not.toThrow();
    expect(() => beginUpstreamRequest(Number.NaN)()).not.toThrow();
  });
});
