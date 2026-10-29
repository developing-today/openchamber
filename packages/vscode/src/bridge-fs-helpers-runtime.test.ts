import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

// This module imports `vscode`, which the isolated test runner cannot resolve,
// so the search ceiling is pinned on the source text like `webviewHtml.test.ts`
// pins the CSP, alongside its deliberate mirror in the web server.
const helpersSource = readFileSync(new URL('./bridge-fs-helpers-runtime.ts', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('./bridge-fs-runtime.ts', import.meta.url), 'utf8');
const webSearchSource = readFileSync(new URL('../../web/server/lib/fs/search.js', import.meta.url), 'utf8');

describe('filesystem search inspected-file ceiling', () => {
  for (const [label, source] of [['VS Code', helpersSource], ['web', webSearchSource]] as const) {
    test(`${label} query searches stop on inspected files, not the old candidate cap`, () => {
      assert.doesNotMatch(source, /Math\.max\(limit \* 3, 200\)/);
      assert.match(source, /FILE_SEARCH_MAX_VISITED_FILES = 10_000/);
      assert.match(source, /inspectedFiles >= FILE_SEARCH_MAX_VISITED_FILES/);
    });
  }
});

describe('bridge fs env readers judge values by their whole text', () => {
  // The helpers module's reader cannot be imported here (see above), so it is
  // pinned on the source text; the identical runtime reader is covered
  // behaviourally in bridge-fs-runtime.test.js.
  for (const [label, source] of [['helpers', helpersSource], ['runtime', runtimeSource]] as const) {
    test(`${label} check-ignore timeout reader parses a plain decimal, never bare Number(...)`, () => {
      assert.doesNotMatch(source, /Number\(process\.env\.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS\)/);
      assert.match(source, /parsePlainDecimalInt\(process\.env\.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS\)/);
    });
  }

  for (const [label, source] of [['helpers', helpersSource], ['runtime', runtimeSource]] as const) {
    test(`${label} check-ignore timeout reader falls back above the timer maximum`, () => {
      assert.match(source, /raw <= 2_147_483_647/);
    });
  }

  test('runtime read-cache TTL reader parses a plain decimal, never bare Number(...)', () => {
    assert.doesNotMatch(runtimeSource, /Number\(process\.env\.OPENCHAMBER_GIT_READ_CACHE_TTL_MS\)/);
    assert.match(runtimeSource, /parsePlainDecimalInt\(process\.env\.OPENCHAMBER_GIT_READ_CACHE_TTL_MS\)/);
  });
});
