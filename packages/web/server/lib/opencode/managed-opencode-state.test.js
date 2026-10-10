import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearManagedOpenCodeState,
  createLaunchFingerprint,
  decideManagedOpenCodeLaunch,
  hashLaunchSecret,
  readLogSince,
  readLogTail,
  readManagedOpenCodeState,
  resolveManagedOpenCodePaths,
  writeManagedOpenCodeState,
} from './managed-opencode-state.js';

const validState = {
  pid: 4242,
  port: 45678,
  binary: '/usr/bin/opencode',
  fingerprint: 'abc123',
  password: 'secret-password',
  agentToolToken: null,
  startedAt: '2026-01-01T00:00:00.000Z',
};

const adoptable = {
  state: { ...validState, version: 1 },
  ownsPid: true,
  binary: '/usr/bin/opencode',
  fingerprint: 'abc123',
  port: 45678,
  healthy: true,
};

describe('decideManagedOpenCodeLaunch', () => {
  it('starts when there is no saved state', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, state: null })).toEqual({ action: 'start', reason: 'no-state' });
  });

  it('starts without signalling when the recorded pid is not verified as OpenCode', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, ownsPid: false })).toEqual({ action: 'start', reason: 'recorded-process-gone' });
  });

  it('replaces when the binary changed', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, binary: '/opt/new/opencode' })).toEqual({ action: 'replace', reason: 'binary-changed' });
  });

  it('replaces when the port changed', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, port: 45679 })).toEqual({ action: 'replace', reason: 'port-changed' });
  });

  it('replaces when the launch fingerprint changed', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, fingerprint: 'other' })).toEqual({ action: 'replace', reason: 'launch-config-changed' });
  });

  it('replaces when the health check fails', () => {
    expect(decideManagedOpenCodeLaunch({ ...adoptable, healthy: false })).toEqual({ action: 'replace', reason: 'unhealthy' });
  });

  it('adopts when pid, binary, port, fingerprint and health all match', () => {
    expect(decideManagedOpenCodeLaunch(adoptable)).toEqual({ action: 'adopt', reason: 'matches-state' });
  });
});

describe('managed OpenCode state file', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-opencode-state-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('round-trips the saved state with owner-only permissions', () => {
    const { statePath } = resolveManagedOpenCodePaths(root);
    writeManagedOpenCodeState(statePath, validState);

    expect(readManagedOpenCodeState(statePath)).toEqual({ version: 1, ...validState });
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it('accepts a string agent-tool token', () => {
    const { statePath } = resolveManagedOpenCodePaths(root);
    writeManagedOpenCodeState(statePath, { ...validState, agentToolToken: 'token-value' });

    expect(readManagedOpenCodeState(statePath)?.agentToolToken).toBe('token-value');
  });

  it('returns null for a missing file', () => {
    expect(readManagedOpenCodeState(path.join(root, 'missing.json'))).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    const { statePath } = resolveManagedOpenCodePaths(root);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{not json');

    expect(readManagedOpenCodeState(statePath)).toBeNull();
  });

  it.each([
    ['an unknown version', { version: 2 }],
    ['a non-positive pid', { pid: 0 }],
    ['a non-integer port', { port: '45678' }],
    ['an empty binary', { binary: '' }],
    ['a missing fingerprint', { fingerprint: undefined }],
    ['an empty password', { password: '' }],
    ['a non-string agent token', { agentToolToken: 7 }],
  ])('returns null for a state file with %s', (_label, override) => {
    const { statePath } = resolveManagedOpenCodePaths(root);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, ...validState, ...override }));

    expect(readManagedOpenCodeState(statePath)).toBeNull();
  });

  it('clears the state and tolerates a missing file', () => {
    const { statePath } = resolveManagedOpenCodePaths(root);
    writeManagedOpenCodeState(statePath, validState);

    clearManagedOpenCodeState(statePath);
    clearManagedOpenCodeState(statePath);

    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('hashes launch secrets and treats a missing secret as empty', () => {
    expect(hashLaunchSecret('secret-password')).not.toContain('secret-password');
    expect(hashLaunchSecret(undefined)).toBe(hashLaunchSecret(''));
  });
});

describe('launch fingerprint', () => {
  it('is independent of key order', () => {
    expect(createLaunchFingerprint({ a: 1, b: { c: 2, d: 3 } }))
      .toBe(createLaunchFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it('changes when a launch value changes', () => {
    expect(createLaunchFingerprint({ port: 45678 })).not.toBe(createLaunchFingerprint({ port: 45679 }));
  });
});

describe('managed OpenCode log cursor', () => {
  let root;
  let logPath;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-opencode-log-'));
    logPath = path.join(root, 'opencode.log');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads only bytes written after the cursor and advances it', () => {
    fs.writeFileSync(logPath, 'first line\n');
    const first = readLogSince(logPath, 0);
    expect(first).toEqual({ text: 'first line\n', offset: 11 });

    fs.appendFileSync(logPath, 'second line\n');
    expect(readLogSince(logPath, first.offset)).toEqual({ text: 'second line\n', offset: 23 });
  });

  it('returns no text and keeps the cursor when nothing new was written', () => {
    fs.writeFileSync(logPath, 'line\n');
    expect(readLogSince(logPath, 5)).toEqual({ text: '', offset: 5 });
  });

  it('returns empty text for a missing log', () => {
    expect(readLogSince(logPath, 0)).toEqual({ text: '', offset: 0 });
  });

  it('returns the tail of the log from the cursor, capped at maxBytes', () => {
    fs.writeFileSync(logPath, 'abcdefghij');
    expect(readLogTail(logPath, 0, 4)).toBe('ghij');
    expect(readLogTail(logPath, 8, 4)).toBe('ij');
  });

  it('returns an empty tail for a missing log', () => {
    expect(readLogTail(logPath, 0, 16)).toBe('');
  });
});
