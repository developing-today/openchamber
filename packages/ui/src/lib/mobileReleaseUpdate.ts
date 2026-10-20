import { z } from 'zod';
import type { UpdateInfo } from '@/lib/desktop';
import { getClientPlatform, isCapacitorApp } from '@/lib/platform';

/**
 * The installed Android app checked against this fork's GitHub releases,
 * directly from the app. The update store's mobile check goes through the
 * connected server, so a phone that has not connected yet — or whose server
 * predates the fork's update route — never hears about a new release. This
 * check needs nothing but the app itself and network access to GitHub.
 *
 * Every failure returns null: no network, a rate-limited or malformed
 * answer, and "no newer release" all read the same to the caller, which
 * falls back to the server check.
 */

const LATEST_RELEASE_URL = 'https://api.github.com/repos/developing-today/openchamber/releases/latest';

const githubReleaseResponse = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  assets: z
    .array(
      z.object({
        name: z.string(),
        browser_download_url: z.string(),
      }),
    )
    .optional(),
});

type ReleaseFetch = (url: string, init: { headers: { Accept: string } }) => Promise<Response>;

/** Numeric parts of a version string: "v2.3.3" -> [2, 3, 3]. Null when any part is not a number. */
function versionParts(version: string): number[] | null {
  const core = version.trim().replace(/^v/, '').split('-')[0];
  if (!core) return null;
  const parts = core.split('.').map((part) => Number(part));
  return parts.every((part) => Number.isInteger(part) && part >= 0) ? parts : null;
}

/**
 * Compares two release versions: 1 when `left` is newer, -1 when older, 0
 * when equal or when either side is not a plain numeric version (an
 * unparseable version never claims an update).
 */
export function compareReleaseVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  if (!leftParts || !rightParts) return 0;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * The newest published release as update info for `currentVersion`, or
 * null when the installed build is current or the answer cannot be used.
 * The download URL names the release's canonical Android APK asset (the
 * asset `mobile-release.yml` uploads), falling back to any APK asset.
 */
export async function fetchLatestMobileRelease(
  currentVersion: string,
  fetchImpl: ReleaseFetch,
): Promise<UpdateInfo | null> {
  try {
    const response = await fetchImpl(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    const parsed = githubReleaseResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return null;

    const version = parsed.data.tag_name.replace(/^v/, '');
    if (compareReleaseVersions(version, currentVersion) <= 0) return null;

    const assets = parsed.data.assets ?? [];
    const apk = assets.find((asset) => /^OpenChamber-.+-android\.apk$/i.test(asset.name))
      ?? assets.find((asset) => asset.name.toLowerCase().endsWith('.apk'));

    return {
      available: true,
      version,
      currentVersion,
      releaseUrl: parsed.data.html_url,
      downloadUrl: apk?.browser_download_url,
    };
  } catch {
    return null;
  }
}

/**
 * The direct check for the running app: Android Capacitor builds only,
 * compared on the native version the OS reports for the installed APK
 * (not the bundled web UI version). Silent null everywhere else.
 */
export async function checkMobileReleaseUpdate(): Promise<UpdateInfo | null> {
  if (!isCapacitorApp() || getClientPlatform() !== 'android') return null;
  try {
    const { App } = await import('@capacitor/app');
    const info = await App.getInfo();
    const currentVersion = info.version.trim();
    if (!currentVersion) return null;
    return fetchLatestMobileRelease(currentVersion, (url, init) => fetch(url, init));
  } catch {
    return null;
  }
}
