// Version comparison for the desktop update check and the update-notes
// filter. Mirrors the strict contract the other surfaces established
// (#180/#182/#184): parseInt alone accepts '1junk' as 1 and '' as 0, so a
// malformed version would compare as a real one and could claim an update
// that is not there. A version with any non-all-digits core part, or an
// empty core, is unparseable, and an unparseable version never claims an
// update. A prerelease sorts before its release.
const parseVersionForComparison = (value) => {
  const normalized = String(value || '').replace(/^v/, '').split('+')[0];
  const prereleaseIndex = normalized.indexOf('-');
  const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
  const rawParts = core.split('.');
  if (!core || rawParts.some((part) => !/^\d+$/.test(part))) return null;
  return { parts: rawParts.map((part) => Number(part)), prerelease: prereleaseIndex >= 0 };
};

export const compareSemver = (left, right) => {
  const a = parseVersionForComparison(left);
  const b = parseVersionForComparison(right);
  // An unparseable version never claims an update.
  if (!a || !b) return 0;
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (diff !== 0) return diff;
  }
  if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
  return 0;
};
