import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendInstalledSources, isInstalledFromSource, readInstalledSources, removeInstalledSources } from './installed-sources.js';

let dataDir;
let previousDataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-installed-sources-'));
  previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const entry = (overrides = {}) => ({
  skillName: 'skill-creator',
  skillDir: 'skills/skill-creator',
  scope: 'user',
  source: 'opencode',
  sourceId: 'acme',
  sourceRef: 'acme/skills',
  ...overrides,
});

describe('installed skill provenance registry', () => {
  it('round-trips entries keyed by skill name', () => {
    appendInstalledSources([entry(), entry({ skillName: 'other', sourceId: 'other', skillDir: 'skills/other' })]);

    const byName = readInstalledSources();
    expect(byName.get('skill-creator')).toHaveLength(1);
    expect(byName.get('skill-creator')[0]).toMatchObject({ sourceId: 'acme', skillDir: 'skills/skill-creator' });
    expect(byName.get('other')[0]).toMatchObject({ sourceId: 'other' });
  });

  it('adds a second source for the same name and dedupes a reinstall', () => {
    appendInstalledSources([entry()]);
    appendInstalledSources([entry()]);
    appendInstalledSources([entry({ sourceId: 'other', sourceRef: 'other/skills' })]);

    const entries = readInstalledSources().get('skill-creator');
    expect(entries).toHaveLength(2);
    expect(entries.map((held) => held.sourceId)).toEqual(['acme', 'other']);
  });

  it('treats a missing or malformed file as no provenance', () => {
    expect(readInstalledSources().size).toBe(0);

    fs.writeFileSync(path.join(dataDir, 'skills-installed-sources.json'), '{broken');
    expect(readInstalledSources().size).toBe(0);

    fs.writeFileSync(path.join(dataDir, 'skills-installed-sources.json'), JSON.stringify({ version: 99, entries: [entry()] }));
    expect(readInstalledSources().size).toBe(0);
  });

  it('refuses to overwrite a malformed file on append and leaves it byte-identical', () => {
    const file = path.join(dataDir, 'skills-installed-sources.json');
    const corrupt = '{"version":1,"entries":[{"skillName":"skill-a"';
    fs.writeFileSync(file, corrupt);

    expect(() => appendInstalledSources([entry()])).toThrow(/malformed.*refusing to overwrite/);
    expect(fs.readFileSync(file, 'utf8')).toBe(corrupt);
  });

  it('refuses to overwrite a malformed file on remove and leaves it byte-identical', () => {
    const file = path.join(dataDir, 'skills-installed-sources.json');
    const corrupt = '{broken';
    fs.writeFileSync(file, corrupt);

    expect(() => removeInstalledSources('skill-creator')).toThrow(/malformed.*refusing to overwrite/);
    expect(fs.readFileSync(file, 'utf8')).toBe(corrupt);
  });

  it('refuses to overwrite a file with an unrecognized shape on append', () => {
    const file = path.join(dataDir, 'skills-installed-sources.json');
    const wrongShape = JSON.stringify({ version: 99, entries: [entry()] });
    fs.writeFileSync(file, wrongShape);

    expect(() => appendInstalledSources([entry({ skillName: 'other' })])).toThrow(/malformed/);
    expect(fs.readFileSync(file, 'utf8')).toBe(wrongShape);
  });

  it('creates the file on append when it is missing', () => {
    const file = path.join(dataDir, 'skills-installed-sources.json');
    expect(fs.existsSync(file)).toBe(false);

    appendInstalledSources([entry()]);

    expect(readInstalledSources().get('skill-creator')).toHaveLength(1);
  });

  it('ignores entries that are missing their identity', () => {
    appendInstalledSources([entry({ sourceId: '' }), { skillName: '', skillDir: 'x', sourceId: 'a' }, entry({ skillDir: '' })]);

    expect(readInstalledSources().size).toBe(0);
  });

  it('appends nothing when every entry is invalid', () => {
    appendInstalledSources([{ nope: true }]);

    expect(fs.existsSync(path.join(dataDir, 'skills-installed-sources.json'))).toBe(false);
  });

  it('forgets every entry of a deleted skill and keeps the rest', () => {
    appendInstalledSources([entry(), entry({ sourceId: 'other' }), entry({ skillName: 'kept', skillDir: 'skills/kept' })]);

    removeInstalledSources('skill-creator');

    const byName = readInstalledSources();
    expect(byName.has('skill-creator')).toBe(false);
    expect(byName.get('kept')).toHaveLength(1);
    expect(fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('narrows the badge to recorded sources and falls back to the name without records', () => {
    appendInstalledSources([entry()]);
    const byName = readInstalledSources();

    expect(isInstalledFromSource(byName, 'skill-creator', 'acme', 'skills/skill-creator')).toBe(true);
    expect(isInstalledFromSource(byName, 'skill-creator', 'other', 'skills/skill-creator')).toBe(false);
    expect(isInstalledFromSource(byName, 'unrecorded', 'any', 'skills/unrecorded')).toBe(true);
  });
});
