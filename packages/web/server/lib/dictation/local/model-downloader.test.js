import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { archiveMatchesPins, describeTarFailure, downloadToFile, ensureLocalSttModel } from './model-downloader.js';

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

describe('archiveMatchesPins', () => {
  it('returns true when size and checksum both match the pins', async () => {
    const file = tempFile();
    fs.writeFileSync(file, CONTENT);
    await expect(archiveMatchesPins(file, PINS)).resolves.toBe(true);
  });

  it('returns false when the size differs from the pin', async () => {
    const file = tempFile();
    fs.writeFileSync(file, CONTENT.subarray(0, 4));
    await expect(archiveMatchesPins(file, PINS)).resolves.toBe(false);
  });

  it('returns false when the size matches but the checksum differs', async () => {
    const file = tempFile();
    fs.writeFileSync(file, Buffer.from('x'.repeat(CONTENT.length)));
    await expect(archiveMatchesPins(file, PINS)).resolves.toBe(false);
  });

  it('returns false for a missing file', async () => {
    const file = tempFile();
    await expect(archiveMatchesPins(file, PINS)).resolves.toBe(false);
  });
});

describe('ensureLocalSttModel cached archive', () => {
  const FAKE_SPEC = {
    archiveUrl: 'https://example.test/fake-model.tar.bz2',
    extractedDir: 'fake-model',
    requiredFiles: ['model.onnx'],
    ...PINS,
  };

  function setup(cachedBytes) {
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-downloader-models-'));
    const downloadsDir = path.join(modelsDir, '.downloads');
    fs.mkdirSync(downloadsDir, { recursive: true });
    if (cachedBytes) {
      fs.writeFileSync(path.join(downloadsDir, 'fake-model.tar.bz2'), cachedBytes);
    }
    return modelsDir;
  }

  async function fakeExtract(_archivePath, destDir) {
    const dir = path.join(destDir, FAKE_SPEC.extractedDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'model.onnx'), 'fake weights');
  }

  it('reuses a cached archive that matches the pins without fetching', async () => {
    const modelsDir = setup(CONTENT);
    let fetched = false;
    const modelDir = await ensureLocalSttModel({
      modelsDir,
      modelId: 'fake-model',
      spec: FAKE_SPEC,
      extractImpl: fakeExtract,
      fetchImpl: async () => {
        fetched = true;
        return new Response(CONTENT, { status: 200 });
      },
    });
    expect(modelDir).toBe(path.join(modelsDir, 'fake-model'));
    expect(fetched).toBe(false);
    expect(fs.readFileSync(path.join(modelDir, 'model.onnx'), 'utf8')).toBe('fake weights');
  });

  it('discards a cached archive that fails the pins and re-downloads it', async () => {
    const modelsDir = setup(Buffer.from('corrupt cached bytes'));
    let fetched = false;
    const modelDir = await ensureLocalSttModel({
      modelsDir,
      modelId: 'fake-model',
      spec: FAKE_SPEC,
      extractImpl: fakeExtract,
      fetchImpl: async () => {
        fetched = true;
        return new Response(CONTENT, { status: 200 });
      },
    });
    expect(modelDir).toBe(path.join(modelsDir, 'fake-model'));
    expect(fetched).toBe(true);
    expect(fs.readFileSync(path.join(modelDir, 'model.onnx'), 'utf8')).toBe('fake weights');
  });
});
