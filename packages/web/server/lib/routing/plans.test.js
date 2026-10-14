import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { addNote, emptyPlanStore, readNotes, readPlanStore, setModel, setPool, upsertPlan, writePlanStore } from './plans.js';

const NOW = '2026-10-14T09:00:00.000Z';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));

describe('plan store', () => {
  it('creates a plan from its provider and name, then merges later updates into it', () => {
    const first = upsertPlan(emptyPlanStore(), { providerID: 'anthropic', plan: 'Max 20x' }, NOW);
    expect(first.plan).toMatchObject({ id: 'anthropic-max-20x', status: 'active', coverage: 'subscription', quotas: [] });
    const second = upsertPlan(
      first.store,
      { id: 'anthropic-max-20x', fee: { amount: 200, currency: 'USD', period: 'monthly' }, verifiedAt: '2026-10-14' },
      '2026-10-15T00:00:00.000Z',
    );
    expect(second.store.plans).toHaveLength(1);
    expect(second.plan).toMatchObject({
      plan: 'Max 20x',
      fee: { amount: 200 },
      verifiedAt: '2026-10-14',
      createdAt: NOW,
      updatedAt: '2026-10-15T00:00:00.000Z',
    });
  });

  it('clears a field set to null and keeps one that is left out', () => {
    const { store } = upsertPlan(emptyPlanStore(), { providerID: 'openai', plan: 'Plus', expiresOn: '2026-12-01' }, NOW);
    const next = upsertPlan(store, { id: 'openai-plus', expiresOn: null }, NOW);
    expect(next.plan.plan).toBe('Plus');
    expect(next.plan.expiresOn).toBeUndefined();
  });

  it('refuses a plan with no provider, a model with no tier, and an unknown enumeration', () => {
    expect(() => upsertPlan(emptyPlanStore(), { label: 'none' }, NOW)).toThrow('providerID');
    expect(() => setModel(emptyPlanStore(), 'openai/gpt-6-astra', {}, NOW)).toThrow('needs a tier');
    expect(() => upsertPlan(emptyPlanStore(), { providerID: 'openai', coverage: 'lottery' }, NOW)).toThrow();
  });

  it('stores a model tier and a pool purpose beside the plans', () => {
    const withModel = setModel(emptyPlanStore(), 'openai/gpt-6-astra', { tier: 'frontier', coveredBy: ['openai-plus'] }, NOW);
    const withPool = setPool(withModel, 'hard', { tier: 'frontier', purpose: 'debugging with an unknown cause' }, NOW);
    expect(withPool.models['openai/gpt-6-astra']).toMatchObject({ tier: 'frontier', coveredBy: ['openai-plus'] });
    expect(withPool.pools.hard).toMatchObject({ tier: 'frontier', purpose: 'debugging with an unknown cause' });
  });

  it('writes atomically and reads back what it wrote', () => {
    const root = dir();
    const { store } = upsertPlan(emptyPlanStore(), { providerID: 'anthropic', plan: 'Max 20x' }, NOW);
    writePlanStore(store, root);
    expect(fs.readdirSync(root).filter((file) => file.endsWith('.tmp'))).toEqual([]);
    expect(readPlanStore(root).plans.map((plan) => plan.id)).toEqual(['anthropic-max-20x']);
  });

  it('treats a malformed plan file as an error, never as an empty store', () => {
    const root = dir();
    fs.writeFileSync(path.join(root, 'plans.json'), '{ not json');
    expect(() => readPlanStore(root)).toThrow(expect.objectContaining({ status: 409 }));
    fs.writeFileSync(path.join(root, 'plans.json'), JSON.stringify({ version: 2, plans: [] }));
    expect(() => readPlanStore(root)).toThrow(/plan store format/);
  });

  it('keeps notes in order, filters them, and skips a damaged line while counting it', () => {
    const root = dir();
    addNote({ text: 'ran out of claude too fast', kind: 'experience', providerID: 'anthropic' }, '2026-10-10T10:00:00.000Z', root);
    addNote({ text: 'I always have GPT left at month end', kind: 'expectation', providerID: 'openai' }, '2026-10-11T10:00:00.000Z', root);
    fs.appendFileSync(path.join(root, 'plan-notes.jsonl'), 'not a note\n');
    const all = readNotes({}, root);
    expect(all.notes.map((note) => note.text)).toEqual([
      'ran out of claude too fast',
      'I always have GPT left at month end',
    ]);
    expect(all.skipped).toBe(1);
    expect(readNotes({ providerID: 'anthropic' }, root).notes).toHaveLength(1);
    expect(readNotes({ limit: 1 }, root).notes[0]?.kind).toBe('expectation');
  });

  it('refuses a blank note', () => {
    expect(() => addNote({ text: '   ' }, NOW, dir())).toThrow('some text');
  });
});
