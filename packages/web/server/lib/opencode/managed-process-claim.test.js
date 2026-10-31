import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimManagedProcess, createManagedProcessRegistry } from './managed-process-registry.js';

// A holder pid only counts as holding while it is alive, so the race tests
// use a real live process as the holder instead of an arbitrary number.
const spawnLiveProcess = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });

const deadPid = async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
};

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
    const holder = spawnLiveProcess();
    try {
      expect(claimManagedProcess(500, 100, holder.pid)).toBe(holder.pid);
      expect(claimManagedProcess(500, 100, 202)).toBe(holder.pid);
      expect(claimManagedProcess(500, 100, holder.pid)).toBe(holder.pid);
    } finally {
      holder.kill();
    }
  });

  it('supersedes a claim whose recorded holder is dead (#942)', async () => {
    const dead = await deadPid();
    expect(claimManagedProcess(500, 100, dead)).toBe(dead);
    expect(claimManagedProcess(500, 100, 202)).toBe(202);
    expect(fs.readFileSync(path.join(dir, '500.claim-from-100'), 'utf8')).toBe('202');
  });

  it('treats a handover from another owner as a new claim', () => {
    claimManagedProcess(500, 100, 201);
    expect(claimManagedProcess(500, 201, 202)).toBe(202);
  });
});

describe('claim file end of life (#942)', () => {
  let dir;
  let previous;
  beforeEach(() => {
    previous = process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-claim-eol-'));
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = dir;
  });
  afterEach(() => {
    process.env.OPENCHAMBER_MANAGED_PROCESS_REGISTRY = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('unregister removes the pid claim files and leaves other pids alone', async () => {
    fs.writeFileSync(path.join(dir, '500.claim-from-100'), '201');
    fs.writeFileSync(path.join(dir, '500.claim-from-201'), '202');
    fs.writeFileSync(path.join(dir, '501.claim-from-100'), '201');
    const registry = createManagedProcessRegistry();
    await registry.unregisterManagedProcess(500);
    expect(fs.existsSync(path.join(dir, '500.claim-from-100'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '500.claim-from-201'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '501.claim-from-100'))).toBe(true);
  });

  it('the reaper sweeps claims whose holder is dead and keeps live-holder claims', async () => {
    const dead = await deadPid();
    const live = spawnLiveProcess();
    try {
      fs.writeFileSync(path.join(dir, '500.claim-from-100'), String(dead));
      fs.writeFileSync(path.join(dir, '501.claim-from-100'), String(live.pid));
      const registry = createManagedProcessRegistry();
      await expect(registry.reapOrphanedProcesses({})).resolves.toEqual({ inspected: 0, reaped: 0 });
      expect(fs.existsSync(path.join(dir, '500.claim-from-100'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '501.claim-from-100'))).toBe(true);
    } finally {
      live.kill();
    }
  });
});
