import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renameSyncWithRetry } from '../shared/atomic-rename.js';

const STATE_VERSION = 1;

export const resolveManagedOpenCodePaths = (dataDir) => {
  const dir = path.join(dataDir, 'managed-opencode');
  return {
    dir,
    statePath: path.join(dir, 'state.json'),
    logPath: path.join(dir, 'opencode.log'),
    drainingPath: path.join(dir, 'draining.json'),
  };
};

const isText = (value) => Object.prototype.toString.call(value) === '[object String]';

const canonicalize = (value) => JSON.stringify(value, (_key, item) => {
  if (item == null || Object.getPrototypeOf(item) !== Object.prototype) return item;
  return Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
});

export const hashLaunchSecret = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');

export const createLaunchFingerprint = (launch) => createHash('sha256').update(canonicalize(launch)).digest('hex');

export const readManagedOpenCodeState = (statePath) => {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
  const valid = parsed?.version === STATE_VERSION
    && Number.isInteger(parsed.pid) && parsed.pid > 0
    && Number.isInteger(parsed.port) && parsed.port > 0
    && isText(parsed.binary) && parsed.binary.length > 0
    && isText(parsed.fingerprint)
    && isText(parsed.password) && parsed.password.length > 0
    && (parsed.agentToolToken === null || isText(parsed.agentToolToken))
    && (parsed.args === undefined || (Array.isArray(parsed.args) && parsed.args.every(isText)));
  return valid ? parsed : null;
};

// Replaced OpenCode processes that are still finishing their sessions. Kept apart from
// state.json, which describes only the current process and is cleared when that one exits.
export const readDrainingOpenCodeRecords = (drainingPath) => {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(drainingPath, 'utf8'));
  } catch {
    return [];
  }
  if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.draining)) return [];
  return parsed.draining.filter((record) => (
    Number.isInteger(record?.pid) && record.pid > 0
    && Number.isInteger(record?.port) && record.port > 0
    && isText(record?.binary) && record.binary.length > 0
    && Number.isFinite(record?.drainStartedAt)
  ));
};

export const writeDrainingOpenCodeRecords = (drainingPath, records) => {
  if (records.length === 0) {
    rmSync(drainingPath, { force: true });
    return;
  }
  mkdirSync(path.dirname(drainingPath), { recursive: true, mode: 0o700 });
  const tmpPath = `${drainingPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ version: STATE_VERSION, draining: records }, null, 2)}\n`, { mode: 0o600 });
  renameSyncWithRetry((from, to) => renameSync(from, to), tmpPath, drainingPath);
};

// Holds the managed password and agent-tool token, so the file is 0600 and never logged.
export const writeManagedOpenCodeState = (statePath, state) => {
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ version: STATE_VERSION, ...state }, null, 2)}\n`, { mode: 0o600 });
  renameSyncWithRetry((from, to) => renameSync(from, to), tmpPath, statePath);
};

export const clearManagedOpenCodeState = (statePath) => {
  rmSync(statePath, { force: true });
};

export const sameOpenCodeArgs = (recorded, current) => recorded === undefined
  || (recorded.length === current.length && recorded.every((value, index) => value === current[index]));

// `ownsPid` must be verified against the process command before any signal is sent: a recorded pid can be reused.
// A changed launch keeps the recorded process serving until its replacement is ready (`handoff`); only an
// unhealthy recorded process is replaced in place, because it is not serving anything to hand over.
export const decideManagedOpenCodeLaunch = ({ state, ownsPid, binary, args, fingerprint, port, healthy }) => {
  if (!state) return { action: 'start', reason: 'no-state' };
  if (!ownsPid) return { action: 'start', reason: 'recorded-process-gone' };
  if (!healthy) return { action: 'replace', reason: 'unhealthy' };
  if (state.binary !== binary) return { action: 'handoff', reason: 'binary-changed' };
  if (!sameOpenCodeArgs(state.args, args)) return { action: 'handoff', reason: 'args-changed' };
  if (state.port !== port) return { action: 'handoff', reason: 'port-changed' };
  if (state.fingerprint !== fingerprint) return { action: 'handoff', reason: 'launch-config-changed' };
  return { action: 'adopt', reason: 'matches-state' };
};

// The managed child writes stdout and stderr to this file, not a pipe, so it outlives OpenChamber.
export const readLogSince = (logPath, offset) => {
  let fd = null;
  try {
    fd = openSync(logPath, 'r');
    const length = fstatSync(fd).size - offset;
    if (length <= 0) return { text: '', offset };
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return { text: buffer.toString('utf8', 0, bytesRead), offset: offset + bytesRead };
  } catch {
    return { text: '', offset };
  } finally {
    if (fd !== null) closeSync(fd);
  }
};

export const readLogTail = (logPath, offset, maxBytes) => {
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return '';
  }
  return readLogSince(logPath, Math.max(offset, size - maxBytes)).text;
};
