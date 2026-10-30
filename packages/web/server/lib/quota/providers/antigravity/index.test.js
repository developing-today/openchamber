import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The credential source is wired through configureOpenCodeCredentials, the
// same seam server/index.js uses. Entries are credential rows as the
// running OpenCode lists them; the projection turns the active row of each
// integration into the legacy entry shape the providers consume.
//
// The provider also falls back to the legacy antigravity-accounts.json in
// ANTIGRAVITY_ACCOUNTS_PATHS (Codex review on PR #860). Both locations are
// derived at module load — one from OPENCODE_CONFIG_DIR, one from the home
// directory (USERPROFILE on Windows, HOME elsewhere) — so each test
// points both env vars at an empty temporary home and
// imports a fresh module registry; a real accounts file on the machine
// running the tests can never leak a candidate into these store-only cases.
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;
let isolatedHome = null;

const loadProvider = async () => {
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-antigravity-test-'));
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.OPENCODE_CONFIG_DIR = path.join(isolatedHome, '.config', 'opencode');
  vi.resetModules();
  const [{ configureOpenCodeCredentials }, { fetchQuota }] = await Promise.all([
    import('../../../opencode/auth.js'),
    import('./index.js'),
  ]);
  return { configureOpenCodeCredentials, fetchQuota };
};

const googleOAuthEntry = {
  id: 'cred_google_oauth',
  integrationID: 'google',
  label: 'Google',
  active: true,
  value: { type: 'oauth', methodID: 'antigravity', access: 'access-token', refresh: 'refresh-token', expires: 1 },
};

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalOpenCodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDir;
  if (isolatedHome) fs.rmSync(isolatedHome, { recursive: true, force: true });
  isolatedHome = null;
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('Antigravity fetchQuota credential resolution', () => {
  it('resolves a google store entry in the projected shape as configured', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    configureOpenCodeCredentials({ list: async () => [googleOAuthEntry] });
    // Token refresh is refused, so a resolved candidate is observable as
    // the refresh-failure state (configured) rather than "Not configured".
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));

    const result = await fetchQuota();

    expect(result.configured).toBe(true);
    expect(result.error).toBe('Failed to refresh Antigravity token');
  });

  it('does not produce configured:false when the credential store read throws', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    configureOpenCodeCredentials({
      list: async () => {
        throw new Error('OpenCode is not connected yet');
      },
    });
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Failed to read OpenCode credential store');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('still reports Not configured when the store reads fine but holds no google login', async () => {
    const { configureOpenCodeCredentials, fetchQuota } = await loadProvider();
    configureOpenCodeCredentials({ list: async () => [] });
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
