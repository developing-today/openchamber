import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerQuotaRoutes } from './routes.js';

// The managed-credential routes read and write `<data dir>/quota/*.json`, so
// point them at a temporary directory: the real provider-id case below must
// never touch the machine's own stored credentials.
const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-quota-routes-'));

beforeAll(() => {
  process.env.OPENCHAMBER_DATA_DIR = temporaryDataDir;
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(temporaryDataDir, { recursive: true, force: true });
});

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

// `Object.prototype` members are not provider ids. The registries are plain
// objects, so a keyed lookup without an own-property check resolves these
// names to inherited members: `constructor` passed the old truthiness gate and
// `__proto__` reached a call site outside the `try`, both answering 500.
const prototypeNames = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];

describe('credential routes reject Object.prototype names', () => {
  const appWithNoCredentials = () => createApp({
    fetchQuotaForProvider: async (providerId) => result({ providerId, ok: false, configured: false, error: 'Unsupported provider' }),
    fetchQuotaForProviderInstances: async (providerId) => [
      result({ providerId, ok: false, configured: false, error: 'Unsupported provider' }),
    ],
  });

  it.each(prototypeNames)('answers %s exactly like an unknown credential provider', async (providerName) => {
    const app = appWithNoCredentials();
    const unknown = await request(app).get('/api/quota/credentials/not-a-provider');

    for (const method of ['get', 'delete']) {
      const response = await request(app)[method](`/api/quota/credentials/${providerName}`);
      expect(response.status).toBe(unknown.status);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ code: 'UNSUPPORTED_PROVIDER', error: 'Unsupported credential provider' });
    }

    const putResponse = await request(app)
      .put(`/api/quota/credentials/${providerName}`)
      .send({ usageToken: 'token' });
    expect(putResponse.status).toBe(404);
    expect(putResponse.body).toEqual({ code: 'UNSUPPORTED_PROVIDER', error: 'Unsupported credential provider' });

    const validateResponse = await request(app).post(`/api/quota/credentials/${providerName}/validate`);
    expect(validateResponse.status).toBe(404);
    expect(validateResponse.body).toEqual({ code: 'UNSUPPORTED_PROVIDER', error: 'Unsupported credential provider' });

    const importResponse = await request(app).post(`/api/quota/credentials/${providerName}/import`);
    expect(importResponse.status).toBe(404);
    expect(importResponse.body).toEqual({ code: 'UNSUPPORTED_PROVIDER', error: 'Unsupported credential provider' });
  });

  it('keeps real provider ids working on the same routes', async () => {
    const app = appWithNoCredentials();

    const status = await request(app).get('/api/quota/credentials/exe-dev');
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ configured: false });

    const removed = await request(app).delete('/api/quota/credentials/exe-dev');
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ configured: false });

    const fetchResponse = await request(app).get('/api/quota/exe-dev');
    expect(fetchResponse.status).toBe(200);
    expect(fetchResponse.body).toMatchObject({ providerId: 'exe-dev' });
  });
});

describe('GET /api/quota/:providerId passes prototype names to the dispatcher', () => {
  it.each(prototypeNames)('returns the dispatcher unsupported result for %s', async (providerName) => {
    const fetchQuotaForProviderInstances = vi.fn(async (providerId) => [
      result({ providerId, ok: false, configured: false, error: 'Unsupported provider' }),
    ]);
    const app = createApp({ fetchQuotaForProvider: async () => result(), fetchQuotaForProviderInstances });

    const response = await request(app).get(`/api/quota/${providerName}`);

    expect(response.status).toBe(200);
    expect(fetchQuotaForProviderInstances).toHaveBeenCalledWith(providerName);
    expect(response.body).toMatchObject({ providerId: providerName, ok: false, configured: false, error: 'Unsupported provider' });
  });
});
