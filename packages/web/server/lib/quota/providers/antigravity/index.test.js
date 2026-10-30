import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureOpenCodeCredentials } from '../../../opencode/auth.js';
import { fetchQuota } from './index.js';

// The credential source is wired through configureOpenCodeCredentials, the
// same seam server/index.js uses. Entries are credential rows as the
// running OpenCode lists them; the projection turns the active row of each
// integration into the legacy entry shape the providers consume.
const wireStoreEntries = (entries) => configureOpenCodeCredentials({ list: async () => entries });

const googleOAuthEntry = {
  id: 'cred_google_oauth',
  integrationID: 'google',
  label: 'Google',
  active: true,
  value: { type: 'oauth', methodID: 'antigravity', access: 'access-token', refresh: 'refresh-token', expires: 1 },
};

afterEach(() => {
  configureOpenCodeCredentials(null);
  vi.unstubAllGlobals();
});

describe('Antigravity fetchQuota credential resolution', () => {
  it('resolves a google store entry in the projected shape as configured', async () => {
    wireStoreEntries([googleOAuthEntry]);
    // Token refresh is refused, so a resolved candidate is observable as
    // the refresh-failure state (configured) rather than "Not configured".
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));

    const result = await fetchQuota();

    expect(result.configured).toBe(true);
    expect(result.error).toBe('Failed to refresh Antigravity token');
  });

  it('does not produce configured:false when the credential store read throws', async () => {
    configureOpenCodeCredentials({
      list: async () => {
        throw new Error('OpenCode is not connected yet');
      },
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Failed to read OpenCode credential store');
  });

  it('still reports Not configured when the store reads fine but holds no google login', async () => {
    wireStoreEntries([]);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });
});
