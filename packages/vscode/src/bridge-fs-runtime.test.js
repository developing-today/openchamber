import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';

const spawnCalls = [];
let spawnExitCode = 0;
let spawnStdout = '/repo/.git\n/repo/.git\n';
let spawnStderr = '';

const spawnMock = mock((file, args, options) => {
  spawnCalls.push({ file, args, options });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = mock(() => true);
  setTimeout(() => {
    if (spawnStdout) {
      child.stdout.emit('data', Buffer.from(spawnStdout));
    }
    if (spawnStderr) {
      child.stderr.emit('data', Buffer.from(spawnStderr));
    }
    child.emit('close', spawnExitCode, null);
  }, 10);
  return child;
});

mock.module('child_process', () => ({
  spawn: spawnMock,
}));

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    fs: {},
  },
  Uri: {
    file: (fsPath) => ({ fsPath }),
  },
  FileType: {
    Directory: 2,
  },
  window: {},
}));

const {
  clearGitReadCacheForTests,
  createGitCheckIgnoreTimeoutMs,
  createGitReadCacheTtlMs,
  handleFsBridgeMessage,
} = await import('./bridge-fs-runtime');

const deps = {
  resolveUserPath: (value) => value,
  listDirectoryEntries: mock(),
  normalizeFsPath: (value) => value,
  execGit: mock(),
  searchDirectory: mock(),
  resolveFileReadPath: mock(),
  parseDroppedFileReference: mock(),
  readUriAsAttachment: mock(),
};

describe('bridge fs exec git read cache', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnExitCode = 0;
    spawnStdout = '/repo/.git\n/repo/.git\n';
    spawnStderr = '';
    clearGitReadCacheForTests();
  });

  it('dedupes in-flight cacheable git reads and reuses fresh results', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const cwd = '/repo';

    const [first, second] = await Promise.all([
      handleFsBridgeMessage({ id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps),
      handleFsBridgeMessage({ id: '2', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps),
    ]);

    expect(first?.success).toBe(true);
    expect(second?.success).toBe(true);
    expect(spawnCalls).toHaveLength(1);

    const spacedCommand = 'git   rev-parse   --absolute-git-dir   --git-common-dir';
    const cached = await handleFsBridgeMessage({ id: '3', type: 'api:fs:exec', payload: { commands: [spacedCommand], cwd } }, deps);

    expect(spawnCalls).toHaveLength(1);
    expect(cached?.data?.results?.[0]).toMatchObject({
      command: spacedCommand,
      success: true,
      stdout: '/repo/.git\n/repo/.git',
    });
  });

  it('does not cache arbitrary exec commands', async () => {
    const command = 'git status --porcelain';
    const cwd = '/repo';

    await handleFsBridgeMessage({ id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps);
    await handleFsBridgeMessage({ id: '2', type: 'api:fs:exec', payload: { commands: [command], cwd } }, deps);

    expect(spawnCalls).toHaveLength(2);
  });
});

describe('bridge fs exec spawn launch', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnExitCode = 0;
    spawnStdout = '/repo/.git\n/repo/.git\n';
    spawnStderr = '';
    clearGitReadCacheForTests();
  });

  it('launches the command as a single argv entry, not an interpolated exec string', async () => {
    // A command packed with constructs an outer shell would rewrite if the
    // command were interpolated into a shell string: double quotes, $VAR,
    // and a single-quoted command substitution.
    const command = `printf '%s' "$(echo outer)" '$HOME'`;
    const cwd = '/repo';

    const response = await handleFsBridgeMessage(
      { id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } },
      deps,
    );

    expect(response?.success).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    const expectedShell = process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
    const expectedFlag = process.platform === 'win32' ? '/c' : '-c';
    expect(spawnCalls[0].file).toBe(expectedShell);
    expect(spawnCalls[0].args).toEqual([expectedFlag, command]);
    expect(spawnCalls[0].options).toMatchObject({ cwd, windowsHide: true });
  });

  it('reports a non-zero exit as a result instead of throwing', async () => {
    spawnExitCode = 3;
    spawnStdout = 'partial out\n';
    spawnStderr = 'boom\n';
    const command = 'git status --porcelain';
    const cwd = '/repo';

    const response = await handleFsBridgeMessage(
      { id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd } },
      deps,
    );

    expect(response?.success).toBe(true);
    expect(response?.data?.results?.[0]).toMatchObject({
      command,
      success: false,
      exitCode: 3,
      stdout: 'partial out',
      stderr: 'boom',
    });
  });
});

describe('bridge fs env readers', () => {
  const readers = [
    ['OPENCHAMBER_GIT_READ_CACHE_TTL_MS', createGitReadCacheTtlMs, 30_000],
    ['OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS', createGitCheckIgnoreTimeoutMs, 2500],
  ];

  for (const [name, read, fallback] of readers) {
    describe(name, () => {
      let saved;
      beforeEach(() => {
        saved = process.env[name];
      });
      afterEach(() => {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      });

      it('falls back when the variable is unset or not a plain decimal', () => {
        delete process.env[name];
        expect(read()).toBe(fallback);
        // '' and ' ' read as 0 under bare Number(...): that would disable the
        // cache / disarm the kill timeout. Exponent, hex and fractional
        // spellings are numbers the user never wrote.
        for (const value of ['', ' ', '1e3', '0x10', '5.9', '-5', '10ms']) {
          process.env[name] = value;
          expect(read()).toBe(fallback);
        }
      });

      it('honours a plain decimal value, including an explicit 0', () => {
        process.env[name] = '0';
        expect(read()).toBe(0);
        process.env[name] = '1500';
        expect(read()).toBe(1500);
      });
    });
  }
});
