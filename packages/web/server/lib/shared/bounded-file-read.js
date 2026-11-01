import fs from 'node:fs';

// The one bounded read for files whose size the server does not control
// (design #1254): project and user files, as opposed to response bodies
// (response-body.js, #802) and the server's own state files
// (durable-json-store.js, #976). It generalises the family's one correct
// embodiment, skills-catalog/scan.js's readSkillMdFile.
//
// Open once and judge from the handle: stat-then-read by path follows a
// symlink to a device or FIFO (stat size 0) and buffers without bound, and
// a file swapped or grown between the two calls escapes the gate.
// O_NONBLOCK (POSIX only) keeps open() itself from blocking on a FIFO
// with no writer before the handle stat can reject it as non-regular.
// The cap is enforced during the read — at most maxBytes + 1 bytes are
// read — so a file that grows after the stat is over-cap, not buffered.
//
// Expected outcomes are answers, not throws, and the sync and async
// spellings answer identically: missing is distinct from over-cap, and
// both are distinct from non-regular, so adopting this reader never
// changes a caller's missing-file behaviour. Unexpected I/O errors
// (permissions, I/O failures) throw, as they are none of the three.

const openFlags = () =>
  process.platform === 'win32' ? 'r' : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;

const assertMaxBytes = (maxBytes) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative integer, got ${maxBytes}`);
  }
};

const missingResult = (filePath) => ({
  ok: false,
  reason: 'missing',
  code: 'BOUNDED_FILE_MISSING',
  path: filePath,
});

const notRegularResult = (filePath) => ({
  ok: false,
  reason: 'not-regular',
  code: 'BOUNDED_FILE_NOT_REGULAR',
  path: filePath,
});

const tooLargeResult = (filePath, size, maxBytes) => ({
  ok: false,
  reason: 'too-large',
  code: 'BOUNDED_FILE_TOO_LARGE',
  path: filePath,
  size,
  limit: maxBytes,
});

const isMissingError = (error) => error?.code === 'ENOENT';

/**
 * Reads a whole file under a byte cap, refusing anything larger.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<
 *   | { ok: true, buffer: Buffer, size: number }
 *   | { ok: false, reason: 'missing' | 'not-regular', code: string, path: string }
 *   | { ok: false, reason: 'too-large', code: string, path: string, size: number, limit: number }
 * >}
 */
export async function readBoundedFile(filePath, maxBytes) {
  assertMaxBytes(maxBytes);
  let handle;
  try {
    handle = await fs.promises.open(filePath, openFlags());
  } catch (error) {
    if (isMissingError(error)) return missingResult(filePath);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return notRegularResult(filePath);
    if (stat.size > maxBytes) return tooLargeResult(filePath, stat.size, maxBytes);
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    // The stat size is only a hint: a file that grew after it crosses the
    // cap here, having read at most maxBytes + 1 bytes. `size` is then the
    // count actually read (maxBytes + 1), a lower bound on the real size.
    if (total > maxBytes) return tooLargeResult(filePath, total, maxBytes);
    return { ok: true, buffer: buffer.subarray(0, total), size: total };
  } finally {
    await handle.close();
  }
}

/**
 * The synchronous spelling of readBoundedFile; the two answer identically.
 * Reads via readSync on the opened descriptor — no stat-by-path shortcut.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {
 *   | { ok: true, buffer: Buffer, size: number }
 *   | { ok: false, reason: 'missing' | 'not-regular', code: string, path: string }
 *   | { ok: false, reason: 'too-large', code: string, path: string, size: number, limit: number }
 * }
 */
export function readBoundedFileSync(filePath, maxBytes) {
  assertMaxBytes(maxBytes);
  let fd;
  try {
    fd = fs.openSync(filePath, openFlags());
  } catch (error) {
    if (isMissingError(error)) return missingResult(filePath);
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return notRegularResult(filePath);
    if (stat.size > maxBytes) return tooLargeResult(filePath, stat.size, maxBytes);
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = fs.readSync(fd, buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) return tooLargeResult(filePath, total, maxBytes);
    return { ok: true, buffer: buffer.subarray(0, total), size: total };
  } finally {
    fs.closeSync(fd);
  }
}
