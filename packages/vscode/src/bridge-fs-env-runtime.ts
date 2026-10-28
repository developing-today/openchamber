// Whole-number env readers shared by the filesystem bridge. Only a plain
// decimal spelling counts: a bare Number(...) would honour '' and ' ' as 0,
// '1e3' as 1000, '0x10' as 16, and '5.9' as a fractional value. Mirrors the
// web fs readers fixed in #696 (`packages/web/server/lib/fs/routes.js`).
const parsePlainDecimalInt = (raw: string | undefined): number | null => {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

// TTL 0 disables the git read cache, as the documented value. An explicit 0
// keeps that meaning; an empty or malformed value falls back to the default.
export const createGitReadCacheTtlMs = (): number => {
  const raw = parsePlainDecimalInt(process.env.OPENCHAMBER_GIT_READ_CACHE_TTL_MS);
  if (raw !== null && raw >= 0) return raw;
  return 30 * 1000;
};

// Timeout 0 disables the check-ignore kill timeout, as the documented value.
export const createGitCheckIgnoreTimeoutMs = (): number => {
  const raw = parsePlainDecimalInt(process.env.OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS);
  if (raw !== null && raw >= 0) return raw;
  return 2500;
};
