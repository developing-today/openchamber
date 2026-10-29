import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  checkNgrokAuthtokenConfigured,
  checkNgrokAvailable,
  extractNgrokPublicUrlFromText,
  fetchNgrokPublicUrl,
  pollNgrokPublicUrl,
  summarizeNgrokOutput,
} from './ngrok-tunnel.js';

describe('extractNgrokPublicUrlFromText', () => {
  it('extracts public URL from ngrok JSON logs', () => {
    const url = extractNgrokPublicUrlFromText('{"lvl":"info","msg":"started tunnel","url":"https://demo.ngrok-free.app"}\n');

    expect(url).toBe('https://demo.ngrok-free.app');
  });

  it('extracts public URL from ngrok text output', () => {
    const url = extractNgrokPublicUrlFromText('Forwarding https://demo.ngrok-free.app -> http://127.0.0.1:3000');

    expect(url).toBe('https://demo.ngrok-free.app');
  });

  it('ignores non-ngrok URLs', () => {
    const url = extractNgrokPublicUrlFromText('{"url":"https://example.com"}\n');

    expect(url).toBeNull();
  });
});

describe('summarizeNgrokOutput', () => {
  it('prefers actionable JSON error details over trailing help text', () => {
    const summary = summarizeNgrokOutput([
      '{"err":"authentication failed: Your ngrok-agent version \\"3.3.1\\" is too old. The minimum supported agent version for your account is \\"3.20.0\\".\\r\\n\\r\\nERR_NGROK_121\\r\\n","lvl":"crit","msg":"command failed"}',
      'NAME:',
      '  http - start an HTTP tunnel',
    ]);

    expect(summary).toContain('Your ngrok-agent version "3.3.1" is too old');
    expect(summary).toContain('ERR_NGROK_121');
  });

  it('skips bare ERROR lines and keeps the useful error text', () => {
    const summary = summarizeNgrokOutput([
      'ERROR:',
      'ERROR:  authentication failed',
      'ERROR:',
      'ERROR:  ERR_NGROK_121',
    ]);

    expect(summary).toBe('authentication failed ERR_NGROK_121');
  });
});

describe('ngrok availability checks', () => {
  const originalPath = process.env.PATH;
  const originalAuthtoken = process.env.NGROK_AUTHTOKEN;
  const tempDirs = [];

  const installFakeNgrok = (script) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ngrok-check-'));
    tempDirs.push(dir);
    const binary = path.join(dir, 'ngrok');
    fs.writeFileSync(binary, script, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`;
    return binary;
  };

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalAuthtoken === undefined) {
      delete process.env.NGROK_AUTHTOKEN;
    } else {
      process.env.NGROK_AUTHTOKEN = originalAuthtoken;
    }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('reports a prompt ngrok binary as available', async () => {
    const binary = installFakeNgrok('#!/bin/sh\necho "ngrok version 3.20.0"\n');

    const result = await checkNgrokAvailable();

    expect(result.available).toBe(true);
    expect(result.path).toBe(binary);
    expect(result.version).toContain('3.20.0');
  });

  it('settles a hung ngrok version probe as unavailable instead of blocking', async () => {
    installFakeNgrok('#!/bin/sh\nexec sleep 30\n');

    const startedAt = Date.now();
    const result = await checkNgrokAvailable({ timeoutMs: 200 });

    expect(result).toEqual({ available: false, path: null, version: null });
    expect(Date.now() - startedAt).toBeLessThan(10000);
  });

  it('reports a prompt ngrok config check as configured', async () => {
    delete process.env.NGROK_AUTHTOKEN;
    const binary = installFakeNgrok('#!/bin/sh\necho "Valid configuration"\n');

    const result = await checkNgrokAuthtokenConfigured(binary);

    expect(result.configured).toBe(true);
  });

  it('settles a hung ngrok config check as not configured instead of blocking', async () => {
    delete process.env.NGROK_AUTHTOKEN;
    const binary = installFakeNgrok('#!/bin/sh\nexec sleep 30\n');

    const startedAt = Date.now();
    const result = await checkNgrokAuthtokenConfigured(binary, { timeoutMs: 200 });

    expect(result.configured).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(10000);
  });
});

describe('fetchNgrokPublicUrl', () => {
  const tunnelPayload = (tunnels) => ({
    ok: true,
    status: 200,
    json: async () => ({ tunnels }),
  });

  it('prefers the https tunnel and falls back to any tunnel', async () => {
    const preferred = await fetchNgrokPublicUrl({
      fetchImpl: async () => tunnelPayload([
        { proto: 'http', public_url: 'https://fallback.ngrok-free.app' },
        { proto: 'https', public_url: 'https://demo.ngrok-free.app' },
      ]),
    });
    expect(preferred).toBe('https://demo.ngrok-free.app');

    const fallback = await fetchNgrokPublicUrl({
      fetchImpl: async () => tunnelPayload([
        { proto: 'http', public_url: 'https://fallback.ngrok-free.app' },
      ]),
    });
    expect(fallback).toBe('https://fallback.ngrok-free.app');
  });

  it('returns null for a non-ok response', async () => {
    const result = await fetchNgrokPublicUrl({
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    expect(result).toBeNull();
  });

  it('settles a never-answering fetch as null within the deadline', async () => {
    const neverAnswers = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const startedAt = Date.now();
    const result = await fetchNgrokPublicUrl({ fetchImpl: neverAnswers, timeoutMs: 40 });
    expect(result).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('settles a stalled response body read as null within the deadline', async () => {
    let capturedSignal = null;
    const stalledBody = async (_url, { signal }) => {
      capturedSignal = signal;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          capturedSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      };
    };
    const startedAt = Date.now();
    const result = await fetchNgrokPublicUrl({ fetchImpl: stalledBody, timeoutMs: 40 });
    expect(result).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('settles promptly when the caller aborts', async () => {
    const caller = new AbortController();
    const neverAnswers = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const startedAt = Date.now();
    const pending = fetchNgrokPublicUrl({ fetchImpl: neverAnswers, timeoutMs: 10000, signal: caller.signal });
    setTimeout(() => caller.abort(), 20);
    expect(await pending).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

describe('pollNgrokPublicUrl', () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it('never accumulates in-flight fetches against a wedged agent', async () => {
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const neverAnswers = (_url, { signal }) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { inFlight -= 1; reject(new Error('aborted')); }, { once: true });
      });
    };
    const poller = pollNgrokPublicUrl({ fetchImpl: neverAnswers, timeoutMs: 40, intervalMs: 10, onPublicUrl: () => {} });
    await wait(180);
    poller.stop();
    await wait(20);
    expect(maxInFlight).toBe(1);
    expect(calls).toBeGreaterThan(1);
    expect(inFlight).toBe(0);
  });

  it('resolves a child-output URL while a poll fetch is in flight', async () => {
    let captured = null;
    const seen = [];
    const neverAnswers = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const poller = pollNgrokPublicUrl({
      fetchImpl: neverAnswers,
      timeoutMs: 10000,
      intervalMs: 10,
      getPublicUrl: () => captured,
      onPublicUrl: (url) => { seen.push(url); poller.stop(); },
    });
    await wait(50);
    captured = 'https://child.ngrok-free.app';
    await wait(60);
    expect(seen).toEqual(['https://child.ngrok-free.app']);
  });

  it('leaves nothing pending after stop() during an in-flight attempt', async () => {
    let calls = 0;
    let inFlight = 0;
    const neverAnswers = (_url, { signal }) => {
      calls += 1;
      inFlight += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { inFlight -= 1; reject(new Error('aborted')); }, { once: true });
      });
    };
    const poller = pollNgrokPublicUrl({ fetchImpl: neverAnswers, timeoutMs: 10000, intervalMs: 10, onPublicUrl: () => {} });
    await wait(50);
    expect(inFlight).toBe(1);
    poller.stop();
    await wait(30);
    expect(inFlight).toBe(0);
    const callsAfterStop = calls;
    await wait(50);
    expect(calls).toBe(callsAfterStop);
  });
});
