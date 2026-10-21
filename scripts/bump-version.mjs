#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Every package.json a release bumps. `oc-dev create-release` imports this so
// the commit it suggests stages exactly these files.
export const RELEASE_PACKAGE_FILES = [
  'package.json',
  'packages/ui/package.json',
  'packages/web/package.json',
  'packages/sdk/package.json',
  'packages/electron/package.json',
  'packages/vscode/package.json',
];

// a < b for dotted numeric versions; anything after a "-" or "+" is ignored.
export const isVersionOlder = (a, b) => {
  const parts = (version) => version.split(/[-+]/)[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const newVersion = process.argv[2];
  if (!newVersion || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
    console.error('Usage: node scripts/bump-version.mjs <version>');
    console.error('Example: node scripts/bump-version.mjs 0.2.0');
    console.error('Example: node scripts/bump-version.mjs 0.2.0-beta.1');
    process.exit(1);
  }

  // Bun before the pinned version leaves workspace versions in bun.lock
  // unchanged on the refresh below, so packed packages would depend on the
  // previous release (openchamber/openchamber#3633). Refuse before touching
  // anything.
  const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).packageManager?.match(/^bun@(.+)$/)?.[1];
  const installed = execFileSync('bun', ['--version'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (pinned && isVersionOlder(installed, pinned)) {
    console.error(`bun ${installed} is older than the pinned bun@${pinned} (package.json packageManager).`);
    console.error('Its lockfile refresh keeps the old workspace versions, so packed packages would depend on the previous release. Update bun and run this again.');
    process.exit(1);
  }

  console.log(`Bumping version to ${newVersion}\n`);

  for (const pkgPath of RELEASE_PACKAGE_FILES) {
    const fullPath = path.join(ROOT, pkgPath);
    const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    const oldVersion = pkg.version;
    pkg.version = newVersion;
    fs.writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`  ${pkgPath}: ${oldVersion} -> ${newVersion}`);
  }

  // Bun packs workspace:* using the lockfile's version, even after a frozen
  // install. Refresh it with the manifests before any release package is packed.
  execFileSync('bun', ['install', '--lockfile-only', '--ignore-scripts'], { cwd: ROOT, stdio: 'inherit' });

  console.log('\nVersion bump complete. Review changes, then commit and tag.');
}
