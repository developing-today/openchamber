import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STATE_VERSION = 1;

export const resolveManagedOpenCodePaths = (dataDir) => {
  const dir = path.join(dataDir, 'managed-opencode');
  return {
    dir,
    statePath: path.join(dir, 'state.json'),
    logPath: path.join(dir, 'opencode.log'),
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
    && (parsed.agentToolToken === null || isText(parsed.agentToolToken));
  return valid ? parsed : null;
};

// Holds the managed password and agent-tool token, so the file is 0600 and never logged.
export const writeManagedOpenCodeState = (statePath, state) => {
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify({ version: STATE_VERSION, ...state }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, statePath);
};

export const clearManagedOpenCodeState = (statePath) => {
  rmSync(statePath, { force: true });
};

// `ownsPid` must be verified against the process command before any signal is sent: a recorded pid can be reused.
export const decideManagedOpenCodeLaunch = ({ state, ownsPid, binary, fingerprint, port, healthy }) => {
  if (!state) return { action: 'start', reason: 'no-state' };
  if (!ownsPid) return { action: 'start', reason: 'recorded-process-gone' };
  if (state.binary !== binary) return { action: 'replace', reason: 'binary-changed' };
  if (state.port !== port) return { action: 'replace', reason: 'port-changed' };
  if (state.fingerprint !== fingerprint) return { action: 'replace', reason: 'launch-config-changed' };
  if (!healthy) return { action: 'replace', reason: 'unhealthy' };
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
