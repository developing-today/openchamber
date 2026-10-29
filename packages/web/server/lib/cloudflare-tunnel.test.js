import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { checkCloudflaredAvailable } from './cloudflare-tunnel.js';

describe('checkCloudflaredAvailable', () => {
  const originalPath = process.env.PATH;
  const tempDirs = [];

  const installFakeCloudflared = (script) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-cloudflared-check-'));
    tempDirs.push(dir);
    const binary = path.join(dir, 'cloudflared');
    fs.writeFileSync(binary, script, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`;
    return binary;
  };

  afterEach(() => {
    process.env.PATH = originalPath;
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('reports a prompt cloudflared binary as available', async () => {
    const binary = installFakeCloudflared('#!/bin/sh\necho "cloudflared version 2025.1.0"\n');

    const result = await checkCloudflaredAvailable();

    expect(result.available).toBe(true);
    expect(result.path).toBe(binary);
    expect(result.version).toContain('2025.1.0');
  });

  it('settles a hung cloudflared binary as unavailable instead of blocking', async () => {
    installFakeCloudflared('#!/bin/sh\nexec sleep 30\n');

    const startedAt = Date.now();
    const result = await checkCloudflaredAvailable({ timeoutMs: 200 });

    expect(result).toEqual({ available: false, path: null, version: null });
    expect(Date.now() - startedAt).toBeLessThan(10000);
  });
});
