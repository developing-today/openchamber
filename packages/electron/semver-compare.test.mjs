import assert from 'node:assert/strict';
import test from 'node:test';

import { compareSemver } from './semver-compare.mjs';

test('orders parseable versions numerically', () => {
  assert.ok(compareSemver('2.1.0', '2.0.9') > 0);
  assert.ok(compareSemver('2.0.9', '2.1.0') < 0);
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0);
  assert.ok(compareSemver('v2.0.1', '2.0.0') > 0);
  assert.ok(compareSemver('2.0', '2.0.1') < 0);
});

test('never claims an update for a trailing-junk part, on either side', () => {
  // parseInt alone read '1junk' as 1 and claimed a desktop update.
  assert.equal(compareSemver('2.1junk', '2.0.9'), 0);
  assert.equal(compareSemver('2.0.9', '2.1junk'), 0);
});

test('never claims an update for an empty part, on either side', () => {
  assert.equal(compareSemver('2.0.2', '2..1'), 0);
  assert.equal(compareSemver('2..1', '2.0.2'), 0);
  assert.equal(compareSemver('', '2.0.0'), 0);
  assert.equal(compareSemver('2.0.0', ''), 0);
});

test('never claims an update for a non-numeric part, on either side', () => {
  assert.equal(compareSemver('2.0.x', '2.0.0'), 0);
  assert.equal(compareSemver('2.0.0', '2.0.x'), 0);
});

test('sorts a prerelease before its release', () => {
  assert.ok(compareSemver('2.0.0-beta', '2.0.0') < 0);
  assert.ok(compareSemver('2.0.0', '2.0.0-beta') > 0);
  assert.equal(compareSemver('2.0.0-beta', '2.0.0-beta'), 0);
  assert.ok(compareSemver('2.0.1-beta', '2.0.0') > 0);
});
