import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as os from 'node:os';

// Behaviour tests for api:fs:exec against the real child_process spawn:
// only `vscode` is mocked, so these run the actual shell the extension
// host would launch and pin the single-parse semantics the web server's
// spawn argv form has. The mocked launch-form tests live in
// bridge-fs-runtime.test.js.
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

const { clearGitReadCacheForTests, handleFsBridgeMessage } = await import('./bridge-fs-runtime');

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

const runOne = async (command) => {
  const response = await handleFsBridgeMessage(
    { id: '1', type: 'api:fs:exec', payload: { commands: [command], cwd: os.tmpdir() } },
    deps,
  );
  expect(response?.success).toBe(true);
  return response?.data?.results?.[0];
};

// The divergent cases are POSIX shell semantics; on Windows the handler
// launches cmd.exe /c, whose quoting rules are a different contract.
const onPosix = process.platform !== 'win32';

describe('bridge fs exec spawn behaviour (real shell)', () => {
  beforeEach(() => {
    process.env.SHELL = '/bin/sh';
    clearGitReadCacheForTests();
  });

  it('keeps a single-quoted $HOME literal', async () => {
    if (!onPosix) return;
    const result = await runOne("printf '%s' '$HOME'");
    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: '$HOME' });
  });

  it('does not execute a single-quoted command substitution', async () => {
    if (!onPosix) return;
    const result = await runOne("printf '%s' '$(echo SUBSTITUTED)'");
    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: '$(echo SUBSTITUTED)' });
  });

  it('sees a variable assigned earlier in the same command', async () => {
    if (!onPosix) return;
    const result = await runOne('X=hello; printf \'%s\' "$X"');
    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: 'hello' });
  });

  it('reports a non-zero exit with trimmed output instead of throwing', async () => {
    if (!onPosix) return;
    const result = await runOne("printf ' out '; printf ' err ' >&2; exit 3");
    expect(result).toMatchObject({ success: false, exitCode: 3, stdout: 'out', stderr: 'err' });
  });
});
