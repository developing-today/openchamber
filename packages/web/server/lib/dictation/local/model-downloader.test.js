import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { describeTarFailure, downloadToFile } from './model-downloader.js';

const CONTENT = Buffer.from('a fake model archive');
const PINS = { bytes: CONTENT.length, sha256: createHash('sha256').update(CONTENT).digest('hex') };

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-downloader-'));
  return path.join(dir, 'archive.tar.bz2');
}

function fetchReturning(body) {
  return async () => new Response(body, { status: 200 });
}

describe('downloadToFile', () => {
  it('accepts a download whose size and checksum match the pins', async () => {
    const file = tempFile();
    const progress = [];
    await downloadToFile('https://example.test/archive.tar.bz2', file, (done, total) => progress.push([done, total]), {
      ...PINS,
      fetchImpl: fetchReturning(CONTENT),
    });
    expect(fs.readFileSync(file)).toEqual(CONTENT);
    expect(progress.at(-1)).toEqual([CONTENT.length, CONTENT.length]);
  });

  it('aborts a download larger than the pinned size without consuming the whole body', async () => {
    const file = tempFile();
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 50) {
          controller.close();
          return;
        }
        controller.enqueue(Buffer.from('y'.repeat(CONTENT.length)));
      },
    });
    await expect(
      downloadToFile('https://example.test/archive.tar.bz2', file, undefined, { ...PINS, fetchImpl: fetchReturning(body) }),
    ).rejects.toThrow(/larger than the expected/);
    expect(pulls).toBeLessThan(50);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
  });

  it('refuses a download whose checksum differs from the pin', async () => {
    const file = tempFile();
    await expect(
      downloadToFile('https://example.test/archive.tar.bz2', file, undefined, {
        ...PINS,
        sha256: '0'.repeat(64),
        fetchImpl: fetchReturning(CONTENT),
      }),
    ).rejects.toThrow(/did not match its pinned checksum/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses a download shorter than the pinned size', async () => {
    const file = tempFile();
    await expect(
      downloadToFile('https://example.test/archive.tar.bz2', file, undefined, { ...PINS, fetchImpl: fetchReturning(CONTENT.subarray(0, 4)) }),
    ).rejects.toThrow(/incomplete/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses to download a model with no pins, before fetching', async () => {
    const file = tempFile();
    let fetched = false;
    await expect(
      downloadToFile('https://example.test/archive.tar.bz2', file, undefined, {
        fetchImpl: async () => {
          fetched = true;
          return new Response(CONTENT, { status: 200 });
        },
      }),
    ).rejects.toThrow(/No pinned size and checksum/);
    expect(fetched).toBe(false);
  });
});

describe('describeTarFailure', () => {
  it('tells the user to install bzip2 when tar could not run it', () => {
    const stderr = 'tar (child): bzip2: Cannot exec: No such file or directory\ntar: Error is not recoverable: exiting now\n';
    expect(describeTarFailure(2, stderr)).toBe(
      'Extracting voice models needs the bzip2 program. Install it (for example: apt-get install bzip2) and try again.',
    );
  });

  it('keeps the exit code and the last tar message otherwise', () => {
    expect(describeTarFailure(2, 'tar: Unexpected EOF in archive\n')).toBe('tar exited with code 2: tar: Unexpected EOF in archive');
    expect(describeTarFailure(1, '')).toBe('tar exited with code 1');
  });
});
