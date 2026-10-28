import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createGitCheckIgnoreTimeoutMs, createGitReadCacheTtlMs } from './bridge-fs-env-runtime';

const READERS = [
  ['OPENCHAMBER_GIT_READ_CACHE_TTL_MS', createGitReadCacheTtlMs, 30_000],
  ['OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS', createGitCheckIgnoreTimeoutMs, 2500],
] as const;

const readWith = (name: string, value: string | undefined, reader: () => number): number => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return reader();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
};

describe('filesystem bridge env readers (#703)', () => {
  test('honours plain decimal spellings and returns the default when unset', () => {
    for (const [name, reader, fallback] of READERS) {
      assert.equal(readWith(name, '5000', reader), 5000);
      assert.equal(readWith(name, ' 5000 ', reader), 5000);
      assert.equal(readWith(name, undefined, reader), fallback);
    }
  });

  test('falls back to the default for non-plain-decimal spellings', () => {
    for (const [name, reader, fallback] of READERS) {
      for (const invalid of ['', ' ', '1e3', '0x10', '5.9', '+5000', '5000.0', '5000junk']) {
        assert.equal(readWith(name, invalid, reader), fallback, `${name}=${JSON.stringify(invalid)}`);
      }
    }
  });

  test("keeps an explicit '0' for both readers", () => {
    for (const [name, reader] of READERS) {
      assert.equal(readWith(name, '0', reader), 0);
    }
  });
});
