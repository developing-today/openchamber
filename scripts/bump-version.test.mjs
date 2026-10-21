import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isVersionOlder, RELEASE_PACKAGE_FILES } from './bump-version.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test('a release bump packs workspace dependencies at the new version after a frozen install', async () => {
  // The real path: on Windows it also expands an 8.3 TEMP such as C:\Users\BOHDAN~1, which bun's workspace links need.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-release-pack-')));
  roots.push(root);
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.copyFile(new URL('./bump-version.mjs', import.meta.url), path.join(root, 'scripts/bump-version.mjs'));
  for (const file of RELEASE_PACKAGE_FILES) {
    const directory = path.dirname(file);
    await fs.mkdir(path.join(root, directory), { recursive: true });
    const name = file === 'package.json' ? 'release-fixture' : `@openchamber/${path.basename(directory)}`;
    const manifest = { name, version: '1.23.1' };
    if (file === 'package.json') {
      manifest.private = true;
      manifest.workspaces = ['packages/*'];
    }
    if (name === '@openchamber/web') manifest.dependencies = { '@openchamber/sdk': 'workspace:*' };
    if (name === '@openchamber/electron') manifest.dependencies = { '@openchamber/web': 'workspace:*' };
    await fs.writeFile(path.join(root, file), JSON.stringify(manifest));
  }
  const bun = process.execPath;
  const runBun = (args, cwd = root) => execFileSync(bun, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  runBun(['install', '--ignore-scripts']);
  runBun(['run', 'scripts/bump-version.mjs', '1.24.0']);
  // CI uses a frozen install. It must not need to repair release metadata.
  const lockBeforeInstall = await fs.readFile(path.join(root, 'bun.lock'), 'utf8');
  runBun(['install', '--frozen-lockfile', '--ignore-scripts']);
  expect(await fs.readFile(path.join(root, 'bun.lock'), 'utf8')).toBe(lockBeforeInstall);
  for (const [workspace, dependency] of [['web', 'sdk'], ['electron', 'web']]) {
    const archive = path.join(root, `${workspace}.tgz`);
    runBun(['pm', 'pack', '--ignore-scripts', '--filename', archive], path.join(root, 'packages', workspace));
    // Address the archive relative to its directory: under Git Bash on Windows
    // `tar` is GNU tar, which reads an absolute `C:\...` path as a remote host
    // ("Cannot connect to C:"). Windows bsdtar accepts the absolute form, which
    // is why this looked like a flake.
    const packed = JSON.parse(execFileSync('tar', ['-xOf', path.basename(archive), 'package/package.json'], {
      cwd: path.dirname(archive),
      encoding: 'utf8',
    }));
    expect(packed.version).toBe('1.24.0');
    expect(packed.dependencies[`@openchamber/${dependency}`]).toBe('1.24.0');
  }
}, 30_000);

test('compares versions numerically, ignoring pre-release and build suffixes', () => {
  expect(isVersionOlder('1.3.11', '1.4.3')).toBe(true);
  expect(isVersionOlder('1.4.3', '1.4.3')).toBe(false);
  expect(isVersionOlder('1.10.0', '1.9.9')).toBe(false);
  expect(isVersionOlder('1.4', '1.4.1')).toBe(true);
  expect(isVersionOlder('1.4.3-canary.1+abc', '1.4.3')).toBe(false);
});

// The shim is a shell script, which Windows cannot run as `bun`.
test.skipIf(process.platform === 'win32')('refuses to bump with a bun older than the pinned one and changes nothing', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'oc-release-old-bun-')));
  roots.push(root);
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.copyFile(new URL('./bump-version.mjs', import.meta.url), path.join(root, 'scripts/bump-version.mjs'));
  const manifest = JSON.stringify({ name: 'release-fixture', version: '1.23.1', packageManager: 'bun@1.4.3' });
  await fs.writeFile(path.join(root, 'package.json'), manifest);
  // A `bun` first on PATH that reports an old version; the script asks the
  // same `bun` it would run for the lockfile refresh.
  const shims = path.join(root, 'shims');
  await fs.mkdir(shims);
  await fs.writeFile(path.join(shims, 'bun'), '#!/bin/sh\necho 1.3.11\n', { mode: 0o755 });
  let failure;
  try {
    execFileSync(process.execPath, ['scripts/bump-version.mjs', '1.24.0'], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, PATH: `${shims}${path.delimiter}${process.env.PATH}` },
    });
  } catch (error) {
    failure = error;
  }
  expect(failure?.status).toBe(1);
  expect(failure.stderr).toContain('bun 1.3.11 is older than the pinned bun@1.4.3');
  expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toBe(manifest);
}, 30_000);
