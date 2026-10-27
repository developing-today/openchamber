import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerQuotaRoutes } from './routes.js';

const result = (overrides = {}) => ({
  providerId: 'codex',
  providerName: 'Codex',
  ok: true,
  configured: true,
  usage: { windows: {} },
  fetchedAt: 123,
  ...overrides,
});

const createApp = (quotaProviders) => {
  const app = express();
  registerQuotaRoutes(app, { getQuotaProviders: async () => quotaProviders });
  return app;
};

describe('GET /api/quota/:providerId', () => {
  it('returns every per-credential result for a multi-credential provider', async () => {
    const fetchQuotaForProvider = vi.fn(async () => result());
    const app = createApp({
      fetchQuotaForProvider,
      fetchQuotaForProviderInstances: async () => [
        result({ credentialId: 'cred_main', credentialLabel: 'Main', credentialActive: true, accountLabel: 'main@example.com' }),
        result({ credentialId: 'cred_second', credentialLabel: 'Second', credentialActive: false, accountLabel: 'second@example.com' }),
      ],
    });

    const response = await request(app).get('/api/quota/codex');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body[0]).toMatchObject({ credentialId: 'cred_main', credentialLabel: 'Main', credentialActive: true, accountLabel: 'main@example.com' });
    expect(response.body[1]).toMatchObject({ credentialId: 'cred_second', credentialLabel: 'Second', credentialActive: false });
    expect(fetchQuotaForProvider).not.toHaveBeenCalled();
  });

  it('keeps the single-object shape when only one credential answers', async () => {
    const app = createApp({
      fetchQuotaForProvider: async () => result(),
      fetchQuotaForProviderInstances: async () => [result({ credentialId: 'cred_main', credentialLabel: 'Main' })],
    });

    const response = await request(app).get('/api/quota/codex');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(false);
    expect(response.body).toMatchObject({ providerId: 'codex', credentialLabel: 'Main' });
  });

  it('falls back to the single-result fetch when the module has no per-credential entry point', async () => {
    const app = createApp({
      fetchQuotaForProvider: async () => result({ providerName: 'Fallback' }),
    });

    const response = await request(app).get('/api/quota/codex');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ providerId: 'codex', providerName: 'Fallback' });
  });
});
