/**
 * How far a plan has got, read from its `## Steps` checklist.
 *
 * Plans carry their progress in the markdown itself: the knowledge tool tells
 * agents to open a plan with a `## Steps` checklist and to tick a step when it
 * is done. That checklist is the only record, so there is no status field to
 * drift from it. Only the `## Steps` section counts: checklists further down
 * (test lists, acceptance criteria) are detail, not progress.
 */

const STEPS_HEADING = /^##\s+steps\s*$/i;
const SECTION_END = /^#{1,2}\s/;
const CHECKLIST_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s/;

/**
 * Largest plan file the read paths will buffer whole, in bytes.
 *
 * Plans this app writes are clamped to 200,000 characters
 * (PROJECT_PLAN_BODY_MAX_LENGTH in runtime.js) - at most ~800,000 bytes of
 * UTF-8 - but shared plan files are also written by other tools with no
 * clamp. 1 MiB leaves headroom over every app-written plan while keeping
 * one oversized file from being loaded whole into the server.
 */
export const PLAN_FILE_READ_MAX_BYTES = 1024 * 1024;

/**
 * Read a file as UTF-8 reading at most `maxBytes + 1` bytes from one open
 * handle, so a file that grows after its `stat` can never be buffered
 * whole. Returns the text, or null when the file holds more than
 * `maxBytes` bytes at read time. Falls back to a plain read when the
 * injected fs has no `open` (test doubles); the fallback still refuses an
 * over-cap result, it just cannot bound the transient buffer.
 */
export const readBoundedUtf8 = async (fsPromises, filePath, maxBytes) => {
  if (typeof fsPromises.open !== 'function') {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return Buffer.byteLength(raw, 'utf8') > maxBytes ? null : raw;
  }
  const handle = await fsPromises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset > maxBytes ? null : buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
};

/** `{ done, total }` for a plan with a `## Steps` checklist, null otherwise. */
export const parsePlanProgress = (raw) => {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => STEPS_HEADING.test(line));
  if (start === -1) return null;
  let done = 0;
  let total = 0;
  for (const line of lines.slice(start + 1)) {
    if (SECTION_END.test(line)) break;
    const item = line.match(CHECKLIST_ITEM);
    if (!item) continue;
    total += 1;
    if (item[1] !== ' ') done += 1;
  }
  return total === 0 ? null : { done, total };
};

/**
 * Plan files read for the list, remembered by modification time and size.
 *
 * The Plans tab re-reads the list while it is open, and agents tick steps with
 * their own file tools, so no write event announces it. Listing therefore
 * costs one `stat` per plan, and a file is read and parsed again only when it
 * changed since the last listing.
 */
export const createPlanSummaryCache = ({ fsPromises, parseTitle }) => {
  const entries = new Map();

  /**
   * `{ title, progress, mtimeMs }`, or null when the file is gone. Other read
   * errors propagate; the caller decides whether one plan may fail the list.
   */
  const summaryOf = async (filePath) => {
    let stat;
    try {
      stat = await fsPromises.stat(filePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        entries.delete(filePath);
        return null;
      }
      throw error;
    }
    const cached = entries.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.summary;
    }
    if (stat.size > PLAN_FILE_READ_MAX_BYTES) {
      const summary = { title: 'Plan', progress: null, mtimeMs: stat.mtimeMs, tooLarge: true };
      entries.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
      return summary;
    }
    const raw = await readBoundedUtf8(fsPromises, filePath, PLAN_FILE_READ_MAX_BYTES);
    if (raw === null) {
      // Grew past the cap between the stat above and this read.
      const summary = { title: 'Plan', progress: null, mtimeMs: stat.mtimeMs, tooLarge: true };
      entries.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
      return summary;
    }
    const summary = { title: parseTitle(raw), progress: parsePlanProgress(raw), mtimeMs: stat.mtimeMs };
    entries.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
    return summary;
  };

  return { summaryOf };
};
