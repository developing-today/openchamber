import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

// Mock child_process to prevent real spawnSync calls that would hang in tests
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
}));

const {
  checkForUpdates,
  detectPackageManager,
  executeUpdate,
  getCurrentVersion,
  getUpdateCommand,
} = await import('./package-manager.js');

/** Helper: create a fetch mock that routes by URL pattern */
function createFetchMock() {
  const handlers = new Map();

  const mock = vi.fn((url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();

    for (const [pattern, response] of handlers) {
      if (urlStr.includes(pattern)) {
        return Promise.resolve(response);
      }
    }

    return Promise.reject(new Error(`Unexpected fetch call: ${urlStr}`));
  });

  mock.when = (pattern, response) => {
    handlers.set(pattern, response);
    return mock;
  };

  return mock;
}

describe('checkForUpdates', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    fetchMock = createFetchMock();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENCHAMBER_UPDATE_API_URL;
  });

  const release = (tag, extra = {}) => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [],
    body: `notes for ${tag}`,
    html_url: `https://github.com/developing-today/openchamber/releases/tag/${tag}`,
    ...extra,
  });
  const forkReleases = (...releases) => ({ ok: true, json: async () => releases });
  const upstreamCalls = () => fetchMock.mock.calls.filter(([url]) => /api\.openchamber\.dev|registry\.npmjs\.org|raw\.githubusercontent\.com\/openchamber/.test(String(url)));

  it('reports the highest published fork release as the update, for every app type', async () => {
    fetchMock.when('developing-today/openchamber/releases?per_page=30', forkReleases(release('v1.9.10'), release('v1.10.0')));

    for (const appType of ['web', 'desktop-electron', 'vscode']) {
      const result = await checkForUpdates({ currentVersion: '1.9.10', appType });
      expect(result.available).toBe(true);
      expect(result.version).toBe('1.10.0');
      expect(result.releaseUrl).toBe('https://github.com/developing-today/openchamber/releases/tag/v1.10.0');
      expect(result.manualUpdate).toBe(true);
      expect(result.updateCommand).toContain('https://github.com/developing-today/openchamber/releases/tag/v1.10.0');
    }
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('ignores drafts and prereleases when picking the latest release', async () => {
    fetchMock.when('developing-today/openchamber/releases?per_page=30', forkReleases(
      release('v1.11.0', { draft: true }),
      release('v1.10.1-rc.1', { prerelease: true }),
      release('v1.10.0'),
    ));

    const result = await checkForUpdates({ currentVersion: '1.9.10', appType: 'web' });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
  });

  it('picks the highest semver release, not the newest one created', async () => {
    fetchMock.when('developing-today/openchamber/releases?per_page=30', forkReleases(release('v2.2.0'), release('v2.10.0'), release('v2.9.0')));

    const result = await checkForUpdates({ currentVersion: '2.2.0', appType: 'web' });

    expect(result.version).toBe('2.10.0');
  });

  it('reports no update when the fork release has the installed version', async () => {
    fetchMock.when('developing-today/openchamber/releases?per_page=30', forkReleases(release('v1.10.0')));

    const result = await checkForUpdates({ currentVersion: '1.10.0', appType: 'web' });

    expect(result.available).toBe(false);
  });

  it('reports no update and does not fall back to npm when the fork feed is unreachable', async () => {
    fetchMock.when('developing-today/openchamber/releases?per_page=30', { ok: false, status: 503, json: async () => ({}) });

    const result = await checkForUpdates({ currentVersion: '1.9.10', appType: 'web' });

    expect(result.available).toBe(false);
    expect(result.error).toBe('Unable to reach the release feed');
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('uses OPENCHAMBER_UPDATE_API_URL instead of the fork feed when it is set', async () => {
    process.env.OPENCHAMBER_UPDATE_API_URL = 'https://api.openchamber.dev/v1/update/check';
    fetchMock.when('api.openchamber.dev', {
      ok: true,
      json: async () => ({ latestVersion: '1.10.0', updateAvailable: true, releaseNotes: '- override' }),
    });

    const result = await checkForUpdates({ currentVersion: '1.9.10', appType: 'web' });

    expect(result.available).toBe(true);
    expect(result.version).toBe('1.10.0');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('developing-today/openchamber/releases?per_page'))).toBe(false);
  });

  // --- Android APK resolution (the API override still hands over a direct APK URL) ---

  it('resolves an Android APK asset from the fork release when the update API returns an AAB', async () => {
    process.env.OPENCHAMBER_UPDATE_API_URL = 'https://api.openchamber.dev/v1/update/check';
    fetchMock
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({
          latestVersion: '1.10.0',
          updateAvailable: true,
          downloadUrl: 'https://github.com/developing-today/openchamber/releases/download/v1.10.0/OpenChamber-1.10.0-42-android.aab',
        }),
      })
      .when('api.github.com/repos/developing-today/openchamber/releases/tags/v1.10.0', {
        ok: true,
        json: async () => ({
          assets: [{ name: 'OpenChamber-1.10.0-42-android.apk', browser_download_url: 'https://downloads.example/OpenChamber-1.10.0-42-android.apk' }],
        }),
      });

    const result = await checkForUpdates({ appType: 'mobile-capacitor', platform: 'android', currentVersion: '1.9.10' });

    expect(result.downloadUrl).toBe('https://downloads.example/OpenChamber-1.10.0-42-android.apk');
  });
});

describe('getCurrentVersion', () => {
  it('is exported for the CLI update command', () => {
    expect(typeof getCurrentVersion).toBe('function');
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+|unknown$/);
  });
});

describe('getUpdateCommand', () => {
  it('pins the exact target version instead of re-resolving the latest dist-tag', () => {
    expect(getUpdateCommand('npm', { targetVersion: '1.24.1' })).toBe('npm install -g @openchamber/web@1.24.1');
    expect(getUpdateCommand('pnpm', { targetVersion: 'v1.24.1' })).toBe('pnpm add -g @openchamber/web@1.24.1');
    expect(getUpdateCommand('yarn', { targetVersion: '1.24.1' })).toBe('yarn global add @openchamber/web@1.24.1');
    expect(getUpdateCommand('bun', { targetVersion: '1.25.0-beta.1' })).toContain('add -g @openchamber/web@1.25.0-beta.1');
  });

  it('falls back to the latest dist-tag when no target version is given', () => {
    expect(getUpdateCommand('npm')).toBe('npm install -g @openchamber/web@latest');
  });

  it('rejects a target version that is not a concrete version', () => {
    expect(() => getUpdateCommand('npm', { targetVersion: 'latest; rm -rf /' })).toThrow(/Invalid target version/);
  });
});

describe('executeUpdate', () => {
  it('never runs the package manager and points at the fork release', () => {
    vi.mocked(spawnSync).mockClear();

    const result = executeUpdate('npm', { targetVersion: '1.10.0' });

    expect(result.success).toBe(false);
    expect(result.manualUpdate).toBe(true);
    expect(result.error).toContain('https://github.com/developing-today/openchamber/releases/latest');
    expect(result.error).toContain('(v1.10.0)');
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe('CLI update exports', () => {
  it('exports package-manager helpers used by the update command', () => {
    expect(typeof detectPackageManager).toBe('function');
    expect(typeof executeUpdate).toBe('function');
  });
});

describe('checkForUpdates for the Android app', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    fetchMock = createFetchMock();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const apk = (version) => ({
    name: `OpenChamber-${version}-android.apk`,
    browser_download_url: `https://github.com/developing-today/openchamber/releases/download/v${version}/OpenChamber-${version}-android.apk`,
  });

  it('uses the highest published fork release and its APK, never the upstream API', async () => {
    fetchMock
      .when('releases/tags/v2.3.0', {
        ok: true,
        json: async () => ({ assets: [apk('2.3.0')] }),
      })
      .when('developing-today/openchamber/releases?per_page=30', {
        ok: true,
        json: async () => [
          { tag_name: 'v2.4.0', draft: true, prerelease: false, assets: [] },
          { tag_name: 'v2.3.1-beta.1', draft: false, prerelease: true, assets: [] },
          { tag_name: 'v2.3.0', draft: false, prerelease: false, body: '- fork release', html_url: 'https://github.com/developing-today/openchamber/releases/tag/v2.3.0' },
          { tag_name: 'v2.2.0', draft: false, prerelease: false, assets: [] },
        ],
      });

    const result = await checkForUpdates({ currentVersion: '2.2.0', appType: 'mobile-capacitor', platform: 'android' });

    expect(result.available).toBe(true);
    expect(result.version).toBe('2.3.0');
    expect(result.downloadUrl).toBe('https://github.com/developing-today/openchamber/releases/download/v2.3.0/OpenChamber-2.3.0-android.apk');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('api.openchamber.dev'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('registry.npmjs.org'))).toBe(false);
  });

  it('reports no update and does not fall back to npm when the fork feed is unreachable', async () => {
    fetchMock.when('developing-today/openchamber/releases?per_page=30', { ok: false, status: 503, json: async () => ({}) });

    const result = await checkForUpdates({ currentVersion: '2.2.0', appType: 'mobile-capacitor', platform: 'android' });

    expect(result.available).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('registry.npmjs.org'))).toBe(false);
  });
});
