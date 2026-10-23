import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimManagedProcess } from './managed-process-registry.js';

describe('claimManagedProcess', () => {
  let dir;
  let previous;
  beforeEach(() => {
    previous = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-claim-'));
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = dir;
  });
  afterEach(() => {
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets one server take an orphan from a given owner; the other learns who did', () => {
    expect(claimManagedProcess(500, 100, 201)).toBe(201);
    expect(claimManagedProcess(500, 100, 202)).toBe(201);
    expect(claimManagedProcess(500, 100, 201)).toBe(201);
  });

  it('treats a handover from another owner as a new claim', () => {
    claimManagedProcess(500, 100, 201);
    expect(claimManagedProcess(500, 201, 202)).toBe(202);
  });
});
