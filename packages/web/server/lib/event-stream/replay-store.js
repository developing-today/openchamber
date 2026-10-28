import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Durable state for the global stream's local frames. Append-only so a commit is one small write
// before the frame is sent, compacted into a snapshot so the file stays bounded.
//
// The records:
//   { t: 'local', ...entry }            one non-reconstructible local frame
//   { t: 'head', p, u }                 the newest stream position and upstream OpenCode cursor
//   { t: 'trim', p }                    local entries at or below p were dropped by retention
//   { t: 'reset', p, u }                upstream resynced: nothing before p may be replayed
//   { t: 'snapshot', ... }              a compacted replacement for everything before it

const STORE_VERSION = 1;

const RECORD_KIND_LOCAL = 'local';
const RECORD_KIND_HEAD = 'head';
const RECORD_KIND_TRIM = 'trim';
const RECORD_KIND_RESET = 'reset';
const RECORD_KIND_SNAPSHOT = 'snapshot';

const DEFAULT_COMPACT_AFTER_RECORDS = 4096;
const DEFAULT_COMPACT_AFTER_BYTES = 8 * 1024 * 1024;

export function resolveGlobalReplayFilePath(env = process.env, home = os.homedir()) {
  const configured = env.OPENCHAMBER_DATA_DIR === undefined || env.OPENCHAMBER_DATA_DIR === null
    ? ''
    : `${env.OPENCHAMBER_DATA_DIR}`.trim();
  const dataDir = configured ? path.resolve(configured) : path.join(home, '.config', 'openchamber');
  return path.join(dataDir, 'event-stream', 'global-replay.jsonl');
}

const isPosition = (value) => Number.isSafeInteger(value) && value >= 0;

const sanitizeHead = (head) => ({
  position: isPosition(head?.position) ? head.position : 0,
  upstream: head?.upstream === undefined || head?.upstream === null ? '' : `${head.upstream}`,
});

// Entries crossing the file boundary are untrusted: a partial append or an edited file must not
// resurrect a frame with a torn payload.
const sanitizeEntry = (entry) => {
  if (!entry || !isPosition(entry.position)) return null;
  const serializedFrame = `${entry.serializedFrame ?? ''}`;
  if (serializedFrame.length === 0) return null;
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return null;
  if (!isPosition(entry.committedAt)) return null;
  return {
    position: entry.position,
    upstream: entry.upstream === undefined || entry.upstream === null ? '' : `${entry.upstream}`,
    eventId: entry.eventId === undefined || entry.eventId === null ? undefined : `${entry.eventId}`,
    serializedFrame,
    bytes: entry.bytes,
    committedAt: entry.committedAt,
  };
};

const sortAndDedupe = (entries) => {
  const byPosition = new Map();
  for (const entry of entries) byPosition.set(entry.position, entry);
  return [...byPosition.values()].sort((left, right) => left.position - right.position);
};

/**
 * Creates the durable replay store. Without a `filePath` it keeps the same records in memory, which
 * is what tests use to simulate a restart and what a hub runs with outside production.
 */
export function createReplayStore({
  filePath = null,
  now = () => Date.now(),
  warn = (message) => console.warn(`[event-stream] ${message}`),
  compactAfterRecords = DEFAULT_COMPACT_AFTER_RECORDS,
  compactAfterBytes = DEFAULT_COMPACT_AFTER_BYTES,
} = {}) {
  let head = { position: 0, upstream: '' };
  let entries = [];
  let droppedLocalThroughPosition = 0;
  let recordsSinceSnapshot = 0;
  let appendedBytes = 0;
  let writeFailed = false;

  const write = (record) => {
    if (!filePath) return;
    let line;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (error) {
      warn(`could not encode a replay record: ${error?.message ?? error}`);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.appendFileSync(filePath, line, { mode: 0o600 });
      recordsSinceSnapshot += 1;
      appendedBytes += Buffer.byteLength(line);
      writeFailed = false;
    } catch (error) {
      if (!writeFailed) {
        warn(`could not persist replay state to ${filePath}: ${error?.message ?? error}`);
        writeFailed = true;
      }
    }
  };

  const applySnapshot = (record) => {
    head = sanitizeHead(record.head);
    entries = sortAndDedupe((Array.isArray(record.entries) ? record.entries : []).map(sanitizeEntry).filter(Boolean));
    droppedLocalThroughPosition = isPosition(record.droppedLocalThroughPosition)
      ? record.droppedLocalThroughPosition
      : 0;
  };

  const applyRecord = (record) => {
    if (record === null || record === undefined) return;
    if (record.v !== undefined && record.v !== STORE_VERSION) return;
    switch (record.t) {
      case RECORD_KIND_SNAPSHOT:
        applySnapshot(record);
        break;
      case RECORD_KIND_LOCAL: {
        const entry = sanitizeEntry(record.entry);
        if (!entry) return;
        if (entry.position > head.position) head = { position: entry.position, upstream: entry.upstream };
        entries.push(entry);
        break;
      }
      case RECORD_KIND_HEAD: {
        const next = sanitizeHead({ position: record.p, upstream: record.u });
        if (next.position >= head.position) head = next;
        break;
      }
      case RECORD_KIND_TRIM:
        if (isPosition(record.p)) {
          droppedLocalThroughPosition = Math.max(droppedLocalThroughPosition, record.p);
          entries = entries.filter((entry) => entry.position > record.p);
        }
        break;
      case RECORD_KIND_RESET: {
        const next = sanitizeHead({ position: record.p, upstream: record.u });
        head = { position: Math.max(head.position, next.position), upstream: next.upstream };
        droppedLocalThroughPosition = Math.max(droppedLocalThroughPosition, head.position);
        entries = [];
        break;
      }
      default:
        break;
    }
  };

  const load = () => {
    if (filePath) {
      let text = '';
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          warn(`could not read replay state from ${filePath}: ${error?.message ?? error}`);
        }
      }
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          // A torn final line is expected after a killed process; anything after it is not trusted.
          if (index < lines.length - 1) {
            warn(`ignored replay state after a malformed record in ${filePath}`);
          }
          break;
        }
        applyRecord(record);
      }
      entries = sortAndDedupe(entries).filter((entry) => entry.position > droppedLocalThroughPosition);
      const newest = entries.at(-1);
      if (newest && newest.position > head.position) {
        head = { position: newest.position, upstream: newest.upstream };
      }
      if (text.length > 0) {
        recordsSinceSnapshot = lines.filter((line) => line.trim()).length;
        appendedBytes = Buffer.byteLength(text);
      }
    }
    return state();
  };

  const state = () => ({
    head: { ...head },
    entries: entries.map((entry) => ({ ...entry })),
    droppedLocalThroughPosition,
  });

  const compact = () => {
    if (!filePath) {
      recordsSinceSnapshot = 0;
      appendedBytes = 0;
      return;
    }
    const snapshot = {
      v: STORE_VERSION,
      t: RECORD_KIND_SNAPSHOT,
      head: { ...head },
      entries,
      droppedLocalThroughPosition,
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
      recordsSinceSnapshot = 1;
      appendedBytes = Buffer.byteLength(JSON.stringify(snapshot));
      writeFailed = false;
    } catch (error) {
      if (!writeFailed) {
        warn(`could not compact replay state at ${filePath}: ${error?.message ?? error}`);
        writeFailed = true;
      }
    }
  };

  const maybeCompact = () => {
    if (recordsSinceSnapshot >= compactAfterRecords || appendedBytes >= compactAfterBytes) {
      compact();
    }
  };

  return {
    load,
    state,
    appendLocal(entry) {
      const sanitized = sanitizeEntry(entry);
      if (!sanitized) return;
      write({ v: STORE_VERSION, t: RECORD_KIND_LOCAL, entry: sanitized });
      entries.push(sanitized);
      if (sanitized.position > head.position) {
        head = { position: sanitized.position, upstream: sanitized.upstream };
      }
      maybeCompact();
    },
    appendHead(nextHead) {
      const sanitized = sanitizeHead(nextHead);
      if (sanitized.position < head.position) return;
      write({ v: STORE_VERSION, t: RECORD_KIND_HEAD, p: sanitized.position, u: sanitized.upstream });
      head = sanitized;
      maybeCompact();
    },
    appendTrim(throughPosition) {
      if (!isPosition(throughPosition) || throughPosition <= droppedLocalThroughPosition) return;
      write({ v: STORE_VERSION, t: RECORD_KIND_TRIM, p: throughPosition });
      droppedLocalThroughPosition = throughPosition;
      entries = entries.filter((entry) => entry.position > throughPosition);
      maybeCompact();
    },
    appendReset({ position, upstream }) {
      const sanitized = sanitizeHead({ position: Math.max(head.position, position), upstream });
      write({ v: STORE_VERSION, t: RECORD_KIND_RESET, p: sanitized.position, u: sanitized.upstream });
      head = sanitized;
      droppedLocalThroughPosition = Math.max(droppedLocalThroughPosition, sanitized.position);
      entries = [];
      maybeCompact();
    },
    now,
  };
}
