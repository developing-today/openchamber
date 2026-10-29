import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  checkNgrokAuthtokenConfigured,
  checkNgrokAvailable,
  extractNgrokPublicUrlFromText,
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
