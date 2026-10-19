import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renameSyncWithRetry, renameWithRetry } from './bridge-atomic-write';

const codedError = (code: string): Error & { code: string } => Object.assign(new Error(`rename failed: ${code}`), { code });

describe('renameWithRetry', () => {
  test('lands the rename when the first attempt fails with EPERM', async () => {
    let calls = 0;
    await renameWithRetry('tmp', 'dest', async () => {
      calls += 1;
      if (calls === 1) throw codedError('EPERM');
    });
    assert.equal(calls, 2);
  });

  test('surfaces the error after the final retry when the rename keeps failing', async () => {
    let calls = 0;
    await assert.rejects(
      renameWithRetry('tmp', 'dest', async () => {
        calls += 1;
        throw codedError('EBUSY');
      }),
      { code: 'EBUSY' },
    );
    assert.equal(calls, 5);
  });

  test('throws a non-transient error on the first attempt', async () => {
    let calls = 0;
    await assert.rejects(
      renameWithRetry('tmp', 'dest', async () => {
        calls += 1;
        throw codedError('EINVAL');
      }),
      { code: 'EINVAL' },
    );
    assert.equal(calls, 1);
  });

  test('moves a real file with the default rename', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-bridge-atomic-write-'));
    try {
      const from = path.join(dir, 'tmp.json');
      const to = path.join(dir, 'dest.json');
      fs.writeFileSync(from, '{"ok":true}', 'utf8');
      await renameWithRetry(from, to);
      assert.equal(fs.readFileSync(to, 'utf8'), '{"ok":true}');
      assert.equal(fs.existsSync(from), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renameSyncWithRetry', () => {
  test('lands the rename when the first attempt fails with EPERM', () => {
    let calls = 0;
    renameSyncWithRetry('tmp', 'dest', () => {
      calls += 1;
      if (calls === 1) throw codedError('EPERM');
    });
    assert.equal(calls, 2);
  });

  test('surfaces the error after the final retry when the rename keeps failing', () => {
    let calls = 0;
    assert.throws(
      () =>
        renameSyncWithRetry('tmp', 'dest', () => {
          calls += 1;
          throw codedError('EACCES');
        }),
      { code: 'EACCES' },
    );
    assert.equal(calls, 5);
  });

  test('throws a non-transient error on the first attempt', () => {
    let calls = 0;
    assert.throws(
      () =>
        renameSyncWithRetry('tmp', 'dest', () => {
          calls += 1;
          throw codedError('ENOENT');
        }),
      { code: 'ENOENT' },
    );
    assert.equal(calls, 1);
  });
});
