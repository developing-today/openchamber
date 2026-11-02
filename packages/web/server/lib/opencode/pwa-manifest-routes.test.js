import { describe, expect, it } from 'vitest';
import { registerPwaManifestRoute } from './pwa-manifest-routes.js';

const createResponse = () => ({
  headers: new Map(),
  contentType: '',
  body: '',
  setHeader(name, value) {
    this.headers.set(name, value);
    return this;
  },
  type(value) {
    this.contentType = value;
    return this;
  },
  send(value) {
    this.body = value;
    return this;
  },
});

describe('PWA manifest route', () => {
  it('does not fall back to unrelated global session shortcuts for scoped manifests', async () => {
    const routes = new Map();
    const app = {
      get(route, handler) {
        routes.set(route, handler);
      },
    };
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      const sessions = String(url).includes('?directory=')
        ? []
        : [
            {
              id: 'other-session',
              title: 'Other project',
              directory: '/workspace/other',
              time: { updated: 2 },
            },
          ];
      // v2 pages the session list as `{ data, cursor }`.
      return new Response(JSON.stringify({ data: sessions, cursor: {} }));
    };

    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => true,
      });

      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: {} }, res);

      const manifest = JSON.parse(res.body);
      expect(fetchCalls).toHaveLength(2);
      expect(manifest.shortcuts).toEqual([
        {
          name: 'Appearance Settings',
          short_name: 'Settings',
          description: 'Open appearance settings',
          url: '/?settings=appearance',
          icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('includes child session shortcuts for root-scoped manifests', async () => {
    const routes = new Map();
    const app = {
      get(route, handler) {
        routes.set(route, handler);
      },
    };
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify([
        {
          id: 'root-child',
          title: 'Root child',
          directory: '/workspace/app',
          time: { updated: 2 },
        },
      ]));
    };

    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => true,
      });

      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: {} }, res);

      const manifest = JSON.parse(res.body);
      expect(fetchCalls).toEqual(['/api/session?directory=%2F']);
      expect(manifest.shortcuts).toContainEqual({
        name: 'Root child',
        short_name: 'Root child',
        description: 'Open recent session',
        url: '/?session=root-child',
        icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to no shortcuts for an over-cap session list, cancelling the stream', async () => {
    const routes = new Map();
    const app = { get(route, handler) { routes.set(route, handler); } };
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    const chunk = new TextEncoder().encode('x'.repeat(9 * 1024 * 1024));
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        // Never closed: only the reader cancelling can end this body.
      },
      cancel() { cancelled = true; },
    }));
    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => true,
      });
      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: {} }, res);
      const manifest = JSON.parse(res.body);
      expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual(['/?settings=appearance']);
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('parses a session list at the exact 16 MiB cap, envelope included', async () => {
    const routes = new Map();
    const app = { get(route, handler) { routes.set(route, handler); } };
    const originalFetch = globalThis.fetch;
    const cap = 16 * 1024 * 1024;
    const session = { id: 'capped', title: 'Capped session', directory: '/workspace/app', time: { updated: 2 } };
    const build = (pad) => JSON.stringify({ data: [{ ...session, pad: 'x'.repeat(pad) }], cursor: {} });
    const text = build(cap - Buffer.byteLength(build(0)));
    expect(Buffer.byteLength(text)).toBe(cap);
    globalThis.fetch = async () => new Response(text);
    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async () => ({ directory: '/workspace/app' }),
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => true,
      });
      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: {} }, res);
      const manifest = JSON.parse(res.body);
      expect(manifest.shortcuts).toContainEqual(expect.objectContaining({ url: '/?session=capped' }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('leaves session titles out for a caller without credentials and ignores its directory', async () => {
    const routes = new Map();
    const app = {
      get(route, handler) {
        routes.set(route, handler);
      },
    };
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      return { ok: true, json: async () => [{ id: 'secret', title: 'Private', directory: '/workspace/app', time: { updated: 1 } }] };
    };
    const resolvedFrom = [];

    try {
      registerPwaManifestRoute(app, {
        process: { platform: 'darwin' },
        resolveProjectDirectory: async (req) => {
          resolvedFrom.push(req);
          return { directory: '/workspace/app' };
        },
        buildOpenCodeUrl: (route) => route,
        getOpenCodeAuthHeaders: () => ({}),
        readSettingsFromDiskMigrated: async () => ({}),
        normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
        isRequestAuthorized: async () => false,
      });

      const handler = routes.get('/manifest.webmanifest');
      const res = createResponse();
      await handler({ query: { directory: '/etc' } }, res);

      const manifest = JSON.parse(res.body);
      expect(fetchCalls).toEqual([]);
      expect(resolvedFrom).toEqual([]);
      expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual(['/?settings=appearance']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
