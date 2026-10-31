import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOG_CACHE_MAX_ENTRIES,
  catalogCache,
  clearCatalogCacheForTests,
  pruneCatalogCache,
} from './skillsCatalog';

describe('skills catalog cache pruning (#998)', () => {
  afterEach(() => {
    clearCatalogCacheForTests();
  });

  test('sweeps expired entries for keys that are never re-read, and keeps live ones', () => {
    const now = 1_000_000;
    catalogCache.set('expired::', { expiresAt: now - 1, items: [] });
    catalogCache.set('live::', { expiresAt: now + 60_000, items: [] });

    pruneCatalogCache(now);

    assert.equal(catalogCache.has('expired::'), false);
    assert.equal(catalogCache.has('live::'), true);
    assert.equal(catalogCache.size, 1);
  });

  test('enforces the max-entries bound oldest-first', () => {
    const now = 1_000_000;
    for (let i = 0; i < CATALOG_CACHE_MAX_ENTRIES + 5; i += 1) {
      catalogCache.set(`source-${i}::`, { expiresAt: now + 60_000, items: [] });
    }

    pruneCatalogCache(now);

    assert.equal(catalogCache.size, CATALOG_CACHE_MAX_ENTRIES);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(catalogCache.has(`source-${i}::`), false);
    }
    assert.equal(catalogCache.has(`source-${CATALOG_CACHE_MAX_ENTRIES + 4}::`), true);
  });
});
