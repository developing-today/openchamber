/**
 * Project setup for the `openchamber` control tool: what Settings → Projects
 * shows for a project's worktree setup commands, project actions, draft
 * starters and shared plans folder, merged from the personal file
 * (`~/.config/openchamber/projects/<id>.json`) and the team's
 * `<repo>/.openchamber/project.json`, with each source's status.
 *
 * Read only. Setup commands and project actions run when a worktree is made
 * or an action is clicked, outside OpenCode's permission rules, so an agent
 * that could write them could run commands it was never allowed to; writing
 * stays with the user in Settings.
 *
 * Dependencies (`createProjectSetupActions(deps)`), from packages/web/server/index.js:
 * - `readProjectSetup` — `projectConfigRuntime.readProjectSetup`, the read
 *   `GET /api/projects/:projectId/config` answers with.
 * - `listProjects` — `listConfiguredProjects`; the id must name a configured project.
 */
import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';

export const PROJECT_SETUP_ACTION_DEFINITIONS = Object.freeze([
  { action: 'projects.setup', title: 'Show a project\'s setup', description: 'Show projectId\'s setup as Settings → Projects shows it: worktree setup commands and whether a new worktree waits for them, project actions, draft starters, and the shared plans folder, merged from the personal file and the repository\'s .openchamber/project.json (each entry names its source; shared carries the file\'s status). Read only: the user changes setup commands and actions in Settings, since they run outside OpenCode\'s permissions' },
]);

const PROJECT_SETUP_ACTIONS = PROJECT_SETUP_ACTION_DEFINITIONS.map(({ action }) => action);

export const createProjectSetupActions = ({ readProjectSetup, listProjects }) => {
  const projectsSetup = async (input) => {
    const projectId = asNonEmptyString(input.projectId);
    if (!projectId) throw new OpenChamberControlError('projectId is required for projects.setup; projects.list lists them', 400);
    const known = (await listProjects()).some((project) => project.id === projectId);
    if (!known) throw new OpenChamberControlError(`Unknown project: ${projectId}`, 404);
    return { projectId, setup: await readProjectSetup(projectId) };
  };

  const execute = async (action, input = {}) => {
    if (action === 'projects.setup') return projectsSetup(input);
    throw new OpenChamberControlError(`Unsupported project setup action: ${action || 'missing'}`, 400);
  };

  return { actions: PROJECT_SETUP_ACTIONS, execute };
};
