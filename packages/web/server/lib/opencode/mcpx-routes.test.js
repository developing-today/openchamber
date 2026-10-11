import { describe, expect, it } from 'bun:test';
import { registerMcpxRoutes } from './mcpx-routes.js';

describe('MCPX Server Routes', () => {
  it('registers /api/mcpx endpoints on express app', () => {
    const routes = [];
    const mockApp = {
      get: (path, handler) => {
        routes.push(path);
      },
    };

    registerMcpxRoutes(mockApp);

    expect(routes).toContain('/api/mcpx/status');
    expect(routes).toContain('/api/mcpx/namespaces');
    expect(routes).toContain('/api/mcpx/tools');
    expect(routes).toContain('/api/mcpx/types');
    expect(routes).toContain('/api/mcpx/log');
  });
});
