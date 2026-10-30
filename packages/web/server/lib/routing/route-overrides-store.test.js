import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createOverrideStore, resolveOpenCodeDataDir } from './route-overrides-store.js';

const override = (overrides) => ({
  id: 'interpreter:1:0:avoid',
  action: 'avoid',
  providers: ['anthropic'],
  models: [],
  routes: [],
  fixed: true,
  until: 10_000,
  text: 'stop using anthropic',
  summary: 'avoid: anthropic',
  source: 'interpreter',
  createdAt: 1,
  ...overrides,
});

describe('override store', () => {
  it('writes the file OpenCode reads and keeps the origin of each rule', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    store.add([override({ origin: { key: 'claude', option: 'Anthropic provider only' } })]);
    const written = JSON.parse(fs.readFileSync(store.overridesFile, 'utf8'));
    expect(written.version).toBe(1);
    expect(written.overrides[0]).toMatchObject({ action: 'avoid', providers: ['anthropic'] });
    expect(store.list()[0].origin).toEqual({ key: 'claude', option: 'Anthropic provider only' });
  });

  it('hides and drops overrides past their end', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    let clock = 5_000;
    const store = createOverrideStore({ dataDir: dir, now: () => clock });
    store.add([override({ id: 'a', until: 6_000 }), override({ id: 'b', until: 9_000 })]);
    clock = 7_000;
    expect(store.list().map((item) => item.id)).toEqual(['b']);
    store.add([override({ id: 'c', until: 6_500 })]);
    const written = JSON.parse(fs.readFileSync(store.overridesFile, 'utf8'));
    expect(written.overrides.map((item) => item.id)).toEqual(['b']);
  });

  it('removes one rule and says whether it existed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    store.add([override()]);
    expect(store.remove('missing')).toBe(false);
    expect(store.remove('interpreter:1:0:avoid')).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('keeps feedback as lines and skips a line it cannot read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    store.recordFeedback({ key: 'claude', option: 'A', accepted: 'corrected' });
    fs.appendFileSync(store.feedbackFile, 'not json\n');
    store.recordFeedback({ key: 'claude', option: 'A', accepted: false });
    expect(store.readFeedback()).toEqual([
      { time: 5_000, key: 'claude', option: 'A', accepted: 'corrected' },
      { time: 5_000, key: 'claude', option: 'A', accepted: false },
    ]);
  });

  it('preserves a corrupt overrides file instead of silently discarding every rule', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
      const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
      const corrupt = '{"version":1,"overrides":[{"id":"a","action":"avoid"';
      fs.writeFileSync(store.overridesFile, corrupt);
      expect(store.list()).toEqual([]);
      const preservedName = fs.readdirSync(dir).find((name) => name.startsWith('route-overrides.json.corrupt-5000-'));
      expect(preservedName).toBeTruthy();
      const preservedFile = path.join(dir, preservedName);
      expect(fs.readFileSync(preservedFile, 'utf8')).toBe(corrupt);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(preservedFile));
      // No warning may quote the corrupt file's content: JSON.parse errors
      // embed an excerpt, and override text is the user's own sentence.
      const warned = warn.mock.calls.flat().map(String).join(' ');
      expect(warned).not.toContain('avoid');
      // A later save lands in the real file; the corrupt bytes stay preserved.
      store.add([override({ id: 'fresh' })]);
      expect(store.list().map((item) => item.id)).toEqual(['fresh']);
      expect(fs.readFileSync(preservedFile, 'utf8')).toBe(corrupt);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses to overwrite an existing overrides file it cannot read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    // A directory at the store path makes the guard's read fail with EISDIR:
    // an existing file whose bytes can be neither parsed nor preserved, so
    // the save must refuse rather than rename a new file over it.
    fs.mkdirSync(store.overridesFile);
    expect(() => store.add([override({ id: 'fresh' })])).toThrow(
      /Refusing to overwrite the unreadable route overrides file/,
    );
    expect(fs.statSync(store.overridesFile).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves no temp file behind after a save', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    store.add([override()]);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('treats a missing overrides file as empty and preserves nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-overrides-'));
    const store = createOverrideStore({ dataDir: dir, now: () => 5_000 });
    expect(store.list()).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('places the data under XDG_DATA_HOME', () => {
    expect(resolveOpenCodeDataDir({ XDG_DATA_HOME: '/x/data' })).toBe(path.join('/x/data', 'opencode'));
  });
});
