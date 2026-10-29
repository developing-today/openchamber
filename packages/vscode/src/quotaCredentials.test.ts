import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// The import reads the Cursor database under os.homedir(), and the test
// runner's runtime resolves homedir from the environment it starts with, so
// each case runs the real import in a child process whose HOME is the fake
// home. The child also stubs the darwin platform gate before calling it.
const modulePath = fileURLToPath(new URL('./quotaCredentials.ts', import.meta.url));

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const runImport = (sqliteScript: string, timeoutMs: number) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-vscode-cursor-import-'));
  directories.push(home);
  const dbDir = path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(path.join(dbDir, 'state.vscdb'), '');
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir);
  const sqlite = path.join(binDir, 'sqlite3');
  fs.writeFileSync(sqlite, sqliteScript);
  fs.chmodSync(sqlite, 0o755);
  const driver = path.join(home, 'driver.ts');
  fs.writeFileSync(driver, [
    `Object.defineProperty(process, 'platform', { value: 'darwin' });`,
    `const { importCursorCredential } = await import(${JSON.stringify(modulePath)});`,
    `try {`,
    `  const credential = importCursorCredential({ timeoutMs: ${timeoutMs} });`,
    `  console.log('OK ' + JSON.stringify(credential));`,
    `} catch (error) {`,
    `  console.log('ERR ' + (error instanceof Error ? error.message : String(error)));`,
    `}`,
    ``,
  ].join('\n'));

  const startedAt = Date.now();
  const output = execFileSync(process.execPath, [driver], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` },
  });
  return { output: output.trim(), elapsed: Date.now() - startedAt };
};

test('Cursor credential import gives up on a hung sqlite3 within the timeout', () => {
  const { output, elapsed } = runImport('#!/bin/sh\nwhile :; do :; done\n', 250);

  assert.ok(output.startsWith('ERR '), `expected the import to fail, got: ${output}`);
  assert.ok(elapsed < 5_000, `expected settlement within the timeout, took ${elapsed}ms`);
});

test('Cursor credential import returns the stored tokens when sqlite3 answers promptly', () => {
  const rows = JSON.stringify([
    { key: 'cursorAuth/accessToken', value: 'access-token' },
    { key: 'cursorAuth/refreshToken', value: 'refresh-token' },
  ]);
  const { output } = runImport(`#!/bin/sh\nprintf '%s' '${rows}'\n`, 5_000);

  assert.ok(output.startsWith('OK '), `expected the import to succeed, got: ${output}`);
  assert.deepEqual(JSON.parse(output.slice(3)), { accessToken: 'access-token', refreshToken: 'refresh-token' });
});
