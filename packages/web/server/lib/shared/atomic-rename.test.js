import { describe, expect, it } from 'vitest';

import { renameSyncWithRetry, renameWithRetry } from './atomic-rename.js';

const codedError = (code) => {
  const error = new Error(`rename failed: ${code}`);
  error.code = code;
  return error;
};

describe('renameWithRetry', () => {
  it('lands the rename when the first attempt fails with EPERM', async () => {
    let calls = 0;
    const rename = async () => {
      calls += 1;
      if (calls === 1) throw codedError('EPERM');
    };
    await renameWithRetry(rename, 'tmp', 'dest');
    expect(calls).toBe(2);
  });

  it('retries EACCES and EBUSY as well', async () => {
    for (const code of ['EACCES', 'EBUSY']) {
      let calls = 0;
      const rename = async () => {
        calls += 1;
        if (calls <= 2) throw codedError(code);
      };
      await renameWithRetry(rename, 'tmp', 'dest');
      expect(calls).toBe(3);
    }
  });

  it('surfaces the error after the final retry when the rename keeps failing', async () => {
    let calls = 0;
    const rename = async () => {
      calls += 1;
      throw codedError('EPERM');
    };
    await expect(renameWithRetry(rename, 'tmp', 'dest')).rejects.toMatchObject({ code: 'EPERM' });
    expect(calls).toBe(5);
  });

  it('throws a non-transient error on the first attempt', async () => {
    let calls = 0;
    const rename = async () => {
      calls += 1;
      throw codedError('EINVAL');
    };
    await expect(renameWithRetry(rename, 'tmp', 'dest')).rejects.toMatchObject({ code: 'EINVAL' });
    expect(calls).toBe(1);
  });
});

describe('renameSyncWithRetry', () => {
  it('lands the rename when the first attempt fails with EPERM', () => {
    let calls = 0;
    const renameSync = () => {
      calls += 1;
      if (calls === 1) throw codedError('EPERM');
    };
    renameSyncWithRetry(renameSync, 'tmp', 'dest');
    expect(calls).toBe(2);
  });

  it('surfaces the error after the final retry when the rename keeps failing', () => {
    let calls = 0;
    const renameSync = () => {
      calls += 1;
      throw codedError('EBUSY');
    };
    expect(() => renameSyncWithRetry(renameSync, 'tmp', 'dest')).toThrowError(expect.objectContaining({ code: 'EBUSY' }));
    expect(calls).toBe(5);
  });

  it('throws a non-transient error on the first attempt', () => {
    let calls = 0;
    const renameSync = () => {
      calls += 1;
      throw codedError('ENOENT');
    };
    expect(() => renameSyncWithRetry(renameSync, 'tmp', 'dest')).toThrowError(expect.objectContaining({ code: 'ENOENT' }));
    expect(calls).toBe(1);
  });
});
