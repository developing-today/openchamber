import { describe, expect, it, vi } from 'vitest';

import { createProjectSetupActions, PROJECT_SETUP_ACTION_DEFINITIONS } from './project-setup-actions.js';
import { OPENCHAMBER_CONTROL_ACTION_DEFINITIONS } from './actions.js';
import { OpenChamberControlError } from './error.js';

const setup = {
  'setup-worktree': ['bun install'],
  projectActions: [{ id: 'dev', name: 'Dev', command: 'bun run dev' }],
};

const makeActions = () => {
  const readProjectSetup = vi.fn(async () => setup);
  const listProjects = vi.fn(async () => [{ id: 'p1', path: '/repo' }]);
  return { readProjectSetup, actions: createProjectSetupActions({ readProjectSetup, listProjects }) };
};

describe('projects.setup', () => {
  it('returns the merged setup for a configured project', async () => {
    const { readProjectSetup, actions } = makeActions();
    await expect(actions.execute('projects.setup', { projectId: 'p1' })).resolves.toEqual({ projectId: 'p1', setup });
    expect(readProjectSetup).toHaveBeenCalledWith('p1');
  });

  it('refuses an unknown project without reading', async () => {
    const { readProjectSetup, actions } = makeActions();
    const error = await actions.execute('projects.setup', { projectId: 'nope' }).catch((e) => e);
    expect(error).toBeInstanceOf(OpenChamberControlError);
    expect(error.statusCode).toBe(404);
    expect(readProjectSetup).not.toHaveBeenCalled();
  });

  it('requires projectId', async () => {
    const { actions } = makeActions();
    const error = await actions.execute('projects.setup', {}).catch((e) => e);
    expect(error.statusCode).toBe(400);
  });

  it('is registered with the control tool and offers no write action', () => {
    const names = OPENCHAMBER_CONTROL_ACTION_DEFINITIONS.map((definition) => definition.action);
    expect(names).toContain('projects.setup');
    expect(PROJECT_SETUP_ACTION_DEFINITIONS.map((definition) => definition.action)).toEqual(['projects.setup']);
  });
});
