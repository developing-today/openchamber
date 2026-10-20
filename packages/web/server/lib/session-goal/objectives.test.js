import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-objectives-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;
const { goalObjectiveLimits, readObjective, writeObjective } = await import('./objectives.js');

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.OPENCHAMBER_DATA_DIR;
});

describe('goal objective limits', () => {
  it('reads both limits from Settings, and the defaults for missing or out-of-range values', () => {
    expect(goalObjectiveLimits({ sessionGoalObjectiveCharLimit: 12_000, sessionGoalCheckObjectiveCharLimit: 30_000 }))
      .toEqual({ objective: 12_000, check: 30_000 });
    expect(goalObjectiveLimits({ sessionGoalObjectiveCharLimit: 10, sessionGoalCheckObjectiveCharLimit: 'big' }))
      .toEqual({ objective: 5_000, check: 20_000 });
    expect(goalObjectiveLimits(null)).toEqual({ objective: 5_000, check: 20_000 });
  });

  // The goal's own limit is applied before the write; the file must keep a
  // goal whose limit was raised or switched off.
  it('stores and reads back an objective longer than the default limit', async () => {
    const long = 'x'.repeat(12_000);
    await expect(writeObjective('ses_long1', long)).resolves.toEqual({ content: long });
    await expect(readObjective('ses_long1')).resolves.toBe(long);
  });
});
