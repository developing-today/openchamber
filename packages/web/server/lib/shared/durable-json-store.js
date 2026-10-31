// One durable-store contract for the web server's JSON state files
// (design #976, phase 1 — #977). Sixteen server modules used to hand-write
// this machinery around atomic-rename.js, with three divergent spellings
// of the preservation name (one of them collision-prone), strict readers
// private to each module, and write modes stated in some stores and
// silently omitted in others. This module is the shared spelling:
//
// 1. A strict reader answers missing | valid | malformed — never a
//    lenient "malformed reads as empty". The caller supplies the value
//    judgement (isJsonObject for an object-shaped store); a parsed value
//    the caller rejects is malformed, the routing stores' rule.
// 2. A malformed file is preserved aside before it is replaced, under
//    the collision-proof name the later per-store fixes converged on.
//    The preserve step re-reads and re-judges the on-disk bytes first,
//    re-judges them again after the preserve-name check, and verifies
//    the preserved bytes after the rename — a valid replacement that
//    lands in any of those windows is restored to the live path
//    atomically (hard link, never an overwriting rename), so a valid
//    replacement written concurrently is never renamed away.
//    The result distinguishes preserved from preservation-failed, and
//    the contract is fail-closed: a caller whose preservation failed
//    must refuse the write. Raw parse errors are never attached to a
//    result or logged — they can quote the file, and these files hold
//    credentials and user data.
// 3. Writes are atomic and permission-explicit: a unique temp file in
//    the same directory, written with a caller-stated mode, renamed over
//    the destination through atomic-rename.js.
//
// Each piece ships in async and sync spellings (the atomic-rename.js
// precedent) and takes the caller's fs surface by injection, so a store
// that receives fsPromises today keeps its test seam. The module knows
// paths, bytes, JSON and modes only; shapes, defaults and domain errors
// stay with the callers. Divergent policies (relay/key-store.js
// throw-and-stop, agent-memory/runtime.js malformed-is-failure,
// walkthrough/store.js corrupt-is-a-miss) are not this contract and stay
// local — see DOCUMENTATION.md.

import fsSync from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

import { renameSyncWithRetry, renameWithRetry } from './atomic-rename.js';

const PRESERVE_ATTEMPTS = 10;

/**
 * The object judgement for an object-shaped store: a parsed JSON value
 * that is an object (not null, not an array). Pass it as `validateValue`
 * to the reader or the preserve helper; stores with another shape pass
 * their own predicate.
 */
export const isJsonObject = (value) =>
  value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === '[object Object]';

const judgeRaw = (raw, validateValue) => {
  const text = String(raw);
  if (text.trim() === '') return { state: 'missing' };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: 'malformed', raw: text };
  }
  if (validateValue && !validateValue(value)) return { state: 'malformed', raw: text };
  return { state: 'valid', value, raw: text };
};

const isMissingError = (error) => Boolean(error) && error.code === 'ENOENT';

// The preserve step's judging is fail-closed (CodeRabbit review, PR
// #981): a caller-supplied validateValue that throws is a check
// failure, and the documented answer for any failure to read, check,
// or rename is the 'failed' outcome — never a thrown error that a
// caller could mistake for a reason to write anyway. null = failed.
const judgeForPreserve = (raw, validateValue) => {
  try {
    return judgeRaw(raw, validateValue);
  } catch {
    return null;
  }
};

/**
 * Async strict read. Answers `{ state: 'missing' }` for an absent or
 * empty file (the first-run case), `{ state: 'valid', value, raw }`, or
 * `{ state: 'malformed', raw }`. A read failure other than absence
 * throws: a caller that cannot see the current contents must not
 * replace them.
 */
export const readDurableJsonFile = async (filePath, options = {}) => {
  const fs = options.fs ?? fsPromises;
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingError(error)) return { state: 'missing' };
    throw error;
  }
  return judgeRaw(raw, options.validateValue);
};

/** Sync spelling of readDurableJsonFile; the answers are identical. */
export const readDurableJsonFileSync = (filePath, options = {}) => {
  const fs = options.fs ?? fsSync;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissingError(error)) return { state: 'missing' };
    throw error;
  }
  return judgeRaw(raw, options.validateValue);
};

const preservedCandidate = (filePath) =>
  `${filePath}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Async preserve-aside. Re-reads the file and re-judges the bytes that
 * are on disk now: a valid replacement is left in place
 * (`{ preserved: false, outcome: 'replaced' }`), an absent or empty
 * file needs nothing (`outcome: 'missing'`), and a still-malformed file
 * is renamed to a collision-proof sibling (`{ preserved: true,
 * outcome: 'preserved', preservedPath }`). The bytes are re-judged
 * after the preserve-name check and the preserved bytes are verified
 * after the rename; a valid replacement caught in either window is
 * restored to the live path and answers 'replaced'. Any failure to
 * read, check, or rename answers `{ preserved: false,
 * outcome: 'failed' }` — the fail-closed answer, on which the caller
 * must refuse its write.
 */
export const preserveMalformedJsonFile = async (filePath, options = {}) => {
  const fs = options.fs ?? fsPromises;
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingError(error)) return { preserved: false, outcome: 'missing' };
    return { preserved: false, outcome: 'failed' };
  }
  const judged = judgeForPreserve(raw, options.validateValue);
  if (!judged) return { preserved: false, outcome: 'failed' };
  if (judged.state === 'valid') return { preserved: false, outcome: 'replaced' };
  if (judged.state === 'missing') return { preserved: false, outcome: 'missing' };
  for (let attempt = 0; attempt < PRESERVE_ATTEMPTS; attempt += 1) {
    const candidate = preservedCandidate(filePath);
    if (fs.access) {
      let taken = true;
      try {
        await fs.access(candidate);
      } catch (error) {
        if (isMissingError(error)) taken = false;
        else return { preserved: false, outcome: 'failed' };
      }
      if (taken) continue;
    }
    // Re-read and re-judge AFTER the preserve-name check, immediately
    // before the rename (Codex review, PR #981): a valid replacement
    // installed during the awaited access check above must be seen
    // here, not moved to the preserve name by the rename below.
    let rawNow;
    try {
      rawNow = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissingError(error)) return { preserved: false, outcome: 'missing' };
      return { preserved: false, outcome: 'failed' };
    }
    const judgedNow = judgeForPreserve(rawNow, options.validateValue);
    if (!judgedNow) return { preserved: false, outcome: 'failed' };
    if (judgedNow.state === 'valid') return { preserved: false, outcome: 'replaced' };
    if (judgedNow.state === 'missing') return { preserved: false, outcome: 'missing' };
    try {
      await renameWithRetry((from, to) => fs.rename(from, to), filePath, candidate);
    } catch {
      return { preserved: false, outcome: 'failed' };
    }
    // Verify what the rename actually moved. A replacement can still
    // land between the re-read above and the rename; if the preserved
    // bytes judge valid, they were never ours to move: restore them
    // to the live path with a hard link (atomic, and it fails rather
    // than overwriting if a newer file has since taken the path) and
    // answer 'replaced'. If a valid file cannot be verified or safely
    // restored, answer 'failed' — fail-closed, with the bytes still
    // intact under the preserve name.
    let movedRaw;
    try {
      movedRaw = await fs.readFile(candidate, 'utf8');
    } catch {
      return { preserved: false, outcome: 'failed' };
    }
    const judgedMoved = judgeForPreserve(movedRaw, options.validateValue);
    if (!judgedMoved) return { preserved: false, outcome: 'failed' };
    if (judgedMoved.state !== 'valid') {
      return { preserved: true, outcome: 'preserved', preservedPath: candidate };
    }
    try {
      if (fs.link) {
        await fs.link(candidate, filePath);
      } else {
        let liveTaken = true;
        try {
          await fs.access(filePath);
        } catch (error) {
          if (isMissingError(error)) liveTaken = false;
          else return { preserved: false, outcome: 'failed' };
        }
        if (liveTaken) return { preserved: false, outcome: 'failed' };
        await renameWithRetry((from, to) => fs.rename(from, to), candidate, filePath);
        return { preserved: false, outcome: 'replaced' };
      }
    } catch {
      return { preserved: false, outcome: 'failed' };
    }
    try {
      if (fs.unlink) await fs.unlink(candidate);
      else if (fs.rm) await fs.rm(candidate, { force: true });
    } catch {
      // The valid bytes are live again; a leftover preserve copy of
      // them must not turn this answer into a failure.
    }
    return { preserved: false, outcome: 'replaced' };
  }
  return { preserved: false, outcome: 'failed' };
};

/** Sync spelling of preserveMalformedJsonFile; the answers are identical. */
export const preserveMalformedJsonFileSync = (filePath, options = {}) => {
  const fs = options.fs ?? fsSync;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissingError(error)) return { preserved: false, outcome: 'missing' };
    return { preserved: false, outcome: 'failed' };
  }
  const judged = judgeForPreserve(raw, options.validateValue);
  if (!judged) return { preserved: false, outcome: 'failed' };
  if (judged.state === 'valid') return { preserved: false, outcome: 'replaced' };
  if (judged.state === 'missing') return { preserved: false, outcome: 'missing' };
  for (let attempt = 0; attempt < PRESERVE_ATTEMPTS; attempt += 1) {
    const candidate = preservedCandidate(filePath);
    if (fs.existsSync && fs.existsSync(candidate)) continue;
    // Sync mirror of the async re-read/re-judge and the post-rename
    // verification above; the answers are identical.
    let rawNow;
    try {
      rawNow = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (isMissingError(error)) return { preserved: false, outcome: 'missing' };
      return { preserved: false, outcome: 'failed' };
    }
    const judgedNow = judgeForPreserve(rawNow, options.validateValue);
    if (!judgedNow) return { preserved: false, outcome: 'failed' };
    if (judgedNow.state === 'valid') return { preserved: false, outcome: 'replaced' };
    if (judgedNow.state === 'missing') return { preserved: false, outcome: 'missing' };
    try {
      renameSyncWithRetry((from, to) => fs.renameSync(from, to), filePath, candidate);
    } catch {
      return { preserved: false, outcome: 'failed' };
    }
    let movedRaw;
    try {
      movedRaw = fs.readFileSync(candidate, 'utf8');
    } catch {
      return { preserved: false, outcome: 'failed' };
    }
    const judgedMoved = judgeForPreserve(movedRaw, options.validateValue);
    if (!judgedMoved) return { preserved: false, outcome: 'failed' };
    if (judgedMoved.state !== 'valid') {
      return { preserved: true, outcome: 'preserved', preservedPath: candidate };
    }
    try {
      if (fs.linkSync) {
        fs.linkSync(candidate, filePath);
      } else {
        if (fs.existsSync && fs.existsSync(filePath)) return { preserved: false, outcome: 'failed' };
        renameSyncWithRetry((from, to) => fs.renameSync(from, to), candidate, filePath);
        return { preserved: false, outcome: 'replaced' };
      }
    } catch {
      return { preserved: false, outcome: 'failed' };
    }
    try {
      if (fs.unlinkSync) fs.unlinkSync(candidate);
      else if (fs.rmSync) fs.rmSync(candidate, { force: true });
    } catch {
      // As in the async spelling: the valid bytes are live again.
    }
    return { preserved: false, outcome: 'replaced' };
  }
  return { preserved: false, outcome: 'failed' };
};

const requireStatedMode = (mode, caller) => {
  if (!Number.isInteger(mode)) {
    throw new TypeError(
      `${caller}: a stated integer mode is required (for example 0o600 for a secret-bearing store); ` +
        'the write mode is part of the contract, never an accident of the call site',
    );
  }
};

const tempCandidate = (filePath) =>
  `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Async mode-explicit atomic write. `contents` is the serialized file
 * the caller wants on disk (serialization and formatting stay with the
 * caller); `options.mode` is required and is the mode the written file
 * carries. The temp file is unique per write (pid + time + random, in
 * the same directory) and reaches the destination through
 * renameWithRetry; a failed write removes its temp file before the
 * error surfaces.
 */
export const writeDurableJsonFile = async (filePath, contents, options = {}) => {
  requireStatedMode(options.mode, 'writeDurableJsonFile');
  const fs = options.fs ?? fsPromises;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = tempCandidate(filePath);
  try {
    await fs.writeFile(tempPath, contents, { encoding: 'utf8', mode: options.mode });
    await renameWithRetry((from, to) => fs.rename(from, to), tempPath, filePath);
  } catch (error) {
    try {
      await (fs.rm ? fs.rm(tempPath, { force: true }) : fs.unlink(tempPath));
    } catch {
      // The write error is the one the caller needs; a failed temp
      // cleanup must not mask it.
    }
    throw error;
  }
};

/** Sync spelling of writeDurableJsonFile; the behaviour is identical. */
export const writeDurableJsonFileSync = (filePath, contents, options = {}) => {
  requireStatedMode(options.mode, 'writeDurableJsonFileSync');
  const fs = options.fs ?? fsSync;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = tempCandidate(filePath);
  try {
    fs.writeFileSync(tempPath, contents, { encoding: 'utf8', mode: options.mode });
    renameSyncWithRetry((from, to) => fs.renameSync(from, to), tempPath, filePath);
  } catch (error) {
    try {
      if (fs.rmSync) fs.rmSync(tempPath, { force: true });
      else fs.unlinkSync(tempPath);
    } catch {
      // The write error is the one the caller needs.
    }
    throw error;
  }
};
