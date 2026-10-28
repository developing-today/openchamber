import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('vscode', () => ({
  extensions: { getExtension: () => undefined },
  Uri: { file: (fsPath) => ({ fsPath }) },
}));

const { getGitLog } = await import('./gitService.ts?log-max-count-test');

const tempDirs = [];

const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// 55 commits: more than the default page of 50, so an unbounded read and a
// defaulted read are distinguishable.
const makeRepo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-max-count-'));
  tempDirs.push(dir);
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  for (let i = 1; i <= 55; i++) {
    fs.writeFileSync(path.join(dir, 'file.txt'), `v${i}\n`);
    runGit(dir, ['add', 'file.txt']);
    runGit(dir, ['commit', '-m', `c${i}`]);
  }
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('VS Code git service getGitLog maxCount normalization (#641)', () => {
  it('falls back to 50 for invalid maxCount instead of reading unbounded or throwing', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();

    for (const bad of [-5, 2.5, Number.POSITIVE_INFINITY, Number.NaN, 0, 'abc']) {
      const result = await getGitLog(dir, { maxCount: bad });
      expect(result.total).toBe(50);
      expect(result.all).toHaveLength(50);
    }
  });

  it('applies the same fallback on the --all path', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();

    const result = await getGitLog(dir, { maxCount: -5, all: true });
    expect(result.total).toBe(50);
    expect(result.all).toHaveLength(50);
  });

  it('passes valid maxCount through unchanged and defaults when omitted', async () => {
    if (!canRunGit()) return;

    const dir = makeRepo();

    const two = await getGitLog(dir, { maxCount: 2 });
    expect(two.total).toBe(2);
    expect(two.all).toHaveLength(2);

    const omitted = await getGitLog(dir, {});
    expect(omitted.total).toBe(50);

    const noOptions = await getGitLog(dir);
    expect(noOptions.total).toBe(50);
  });
});
