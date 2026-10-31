import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import path from 'path';

import { registerProjectIconRoutes } from './project-icon-routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
      put(routePath, handler) {
        routes.set(`PUT ${routePath}`, handler);
      },
      delete(routePath, handler) {
        routes.set(`DELETE ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  const headers = new Map();
  let statusCode = 200;
  let body = null;

  return {
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    send(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

describe('project icon routes', () => {
  it('uses fallback file extension MIME when metadata points to a missing icon', async () => {
    const { app, getRoute } = createRouteRegistry();
    const jpgBytes = Buffer.from('jpg-bytes');
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const fsPromises = {
      readFile: vi.fn(async (iconPath) => {
        if (iconPath.endsWith('.jpg')) {
          return jpgBytes;
        }
        throw enoent;
      }),
    };

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => ({
        projects: [{
          id: 'proj-1',
          path: '/repo',
          iconImage: { mime: 'image/png', updatedAt: 1, source: 'custom' },
        }],
      }),
      persistSettings: async () => ({}),
      createFsSearchRuntime: () => ({ searchFilesystemFiles: async () => [] }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('GET', '/api/projects/:projectId/icon')({
      params: { projectId: 'proj-1' },
      query: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('Content-Type')).toBe('image/jpeg');
    expect(res.body).toBe(jpgBytes);
    // A repository icon opened as a page must stay inert.
    expect(res.getHeader('Content-Security-Policy')).toContain('sandbox');
    expect(res.getHeader('X-Content-Type-Options')).toBe('nosniff');
  });

  it('discovers a favicon at a Windows project root', async () => {
    const { app, getRoute } = createRouteRegistry();
    const svgBytes = Buffer.from('svg-bytes');
    const fsPromises = {
      readFile: vi.fn(async () => svgBytes),
      stat: vi.fn(async () => ({ size: svgBytes.length })),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => ({
        projects: [{ id: 'proj-1', path: 'C:\\repo' }],
      }),
      persistSettings: async () => ({ projects: [] }),
      createFsSearchRuntime: () => ({
        searchFilesystemFiles: async () => [
          {
            name: 'favicon.svg',
            path: 'C:\\repo\\favicon.svg',
            relativePath: 'favicon.svg',
            extension: 'svg',
          },
        ],
      }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/icon/discover')({
      params: { projectId: 'proj-1' },
      body: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.discoveredPath).toBe('C:\\repo\\favicon.svg');
  });

  it('filters out hidden or test directories and prioritizes public/ assets', async () => {
    const { app, getRoute } = createRouteRegistry();
    const icoBytes = Buffer.from('ico-bytes');
    const fsPromises = {
      readFile: vi.fn(async () => icoBytes),
      stat: vi.fn(async () => ({ size: icoBytes.length })),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    let capturedSearchOptions = null;

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => ({
        projects: [{ id: 'proj-1', path: '/repo' }],
      }),
      persistSettings: async () => ({ projects: [] }),
      createFsSearchRuntime: () => ({
        searchFilesystemFiles: async (_root, options) => {
          capturedSearchOptions = options;
          return [
            {
              name: 'favicon.ico',
              path: '/repo/.local/dep/favicon.ico',
              relativePath: '.local/dep/favicon.ico',
              extension: 'ico',
            },
            {
              name: 'favicon.ico',
              path: '/repo/tests/fixtures/favicon.ico',
              relativePath: 'tests/fixtures/favicon.ico',
              extension: 'ico',
            },
            {
              name: 'favicon.ico',
              path: '/repo/web/public/icons/favicon.ico',
              relativePath: 'web/public/icons/favicon.ico',
              extension: 'ico',
            },
          ];
        },
      }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/icon/discover')({
      params: { projectId: 'proj-1' },
      body: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(capturedSearchOptions).toEqual({
      limit: 200,
      query: 'favicon',
      includeHidden: false,
      respectGitignore: true,
    });
    expect(res.body.discoveredPath).toBe('/repo/web/public/icons/favicon.ico');
  });

  it('prefers svg over ico format in the same directory', async () => {
    const { app, getRoute } = createRouteRegistry();
    const svgBytes = Buffer.from('svg-bytes');
    const fsPromises = {
      readFile: vi.fn(async () => svgBytes),
      stat: vi.fn(async () => ({ size: svgBytes.length })),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => ({
        projects: [{ id: 'proj-1', path: '/repo' }],
      }),
      persistSettings: async () => ({ projects: [] }),
      createFsSearchRuntime: () => ({
        searchFilesystemFiles: async () => [
          {
            name: 'favicon.ico',
            path: '/repo/public/favicon.ico',
            relativePath: 'public/favicon.ico',
            extension: 'ico',
          },
          {
            name: 'favicon.svg',
            path: '/repo/public/favicon.svg',
            relativePath: 'public/favicon.svg',
            extension: 'svg',
          },
        ],
      }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/icon/discover')({
      params: { projectId: 'proj-1' },
      body: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.discoveredPath).toBe('/repo/public/favicon.svg');
  });

  it('rejects an over-cap favicon from stat without reading it', async () => {
    const { app, getRoute } = createRouteRegistry();
    const maxBytes = 5 * 1024 * 1024;
    const fsPromises = {
      readFile: vi.fn(async () => Buffer.from('should-not-be-read')),
      stat: vi.fn(async () => ({ size: maxBytes + 1 })),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => ({
        projects: [{ id: 'proj-1', path: '/repo' }],
      }),
      persistSettings: async () => ({ projects: [] }),
      createFsSearchRuntime: () => ({
        searchFilesystemFiles: async () => [
          {
            name: 'favicon.png',
            path: '/repo/favicon.png',
            relativePath: 'favicon.png',
            extension: 'png',
          },
        ],
      }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/icon/discover')({
      params: { projectId: 'proj-1' },
      body: {},
    }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Discovered icon exceeds size limit (5 MB)' });
    expect(fsPromises.stat).toHaveBeenCalledWith('/repo/favicon.png');
    expect(fsPromises.readFile).not.toHaveBeenCalled();
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('rejects an empty favicon from stat without reading it', async () => {
    const { app, getRoute } = createRouteRegistry();
    const fsPromises = {
      readFile: vi.fn(async () => Buffer.from('should-not-be-read')),
      stat: vi.fn(async () => ({ size: 0 })),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => ({
        projects: [{ id: 'proj-1', path: '/repo' }],
      }),
      persistSettings: async () => ({ projects: [] }),
      createFsSearchRuntime: () => ({
        searchFilesystemFiles: async () => [
          {
            name: 'favicon.svg',
            path: '/repo/favicon.svg',
            relativePath: 'favicon.svg',
            extension: 'svg',
          },
        ],
      }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/icon/discover')({
      params: { projectId: 'proj-1' },
      body: {},
    }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Discovered icon is empty' });
    expect(fsPromises.readFile).not.toHaveBeenCalled();
  });

  it('discovers an at-cap favicon exactly as before', async () => {
    const { app, getRoute } = createRouteRegistry();
    const maxBytes = 5 * 1024 * 1024;
    const svgBytes = Buffer.from('svg-bytes');
    const fsPromises = {
      readFile: vi.fn(async () => svgBytes),
      stat: vi.fn(async () => ({ size: maxBytes })),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };

    registerProjectIconRoutes(app, {
      fsPromises,
      path,
      crypto,
      openchamberDataDir: '/tmp/openchamber-test',
      sanitizeProjects: (projects) => projects,
      readSettingsFromDiskMigrated: async () => ({
        projects: [{ id: 'proj-1', path: '/repo' }],
      }),
      persistSettings: async () => ({ projects: [] }),
      createFsSearchRuntime: () => ({
        searchFilesystemFiles: async () => [
          {
            name: 'favicon.svg',
            path: '/repo/favicon.svg',
            relativePath: 'favicon.svg',
            extension: 'svg',
          },
        ],
      }),
      spawn: vi.fn(),
      resolveGitBinaryForSpawn: vi.fn(),
    });

    const res = createMockResponse();
    await getRoute('POST', '/api/projects/:projectId/icon/discover')({
      params: { projectId: 'proj-1' },
      body: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.discoveredPath).toBe('/repo/favicon.svg');
    expect(fsPromises.readFile).toHaveBeenCalledWith('/repo/favicon.svg');
    expect(fsPromises.writeFile).toHaveBeenCalled();
  });
});

