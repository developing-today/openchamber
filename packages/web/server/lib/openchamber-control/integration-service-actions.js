/**
 * Connected-service actions for the `openchamber` control tool: GitHub and
 * GitLab accounts, Linear, a repository's source-control binding, and
 * installed extensions with their integration status. (MCP servers, skills
 * and tools are ./integration-actions.js.)
 *
 * Every action runs the same operation its Settings route runs: the route
 * modules return those operations (`accounts` from ../github/routes.js and
 * ../gitlab/routes.js, `bindingOperations` from ../source-control/routes.js,
 * the return of ../linear/routes.js and ../guests/routes.js), and
 * ../opencode/feature-routes-runtime.js hands them out once the routes are
 * registered.
 *
 * Dependencies (`createIntegrationServiceActions(deps)`), with the identifier
 * to pass from packages/web/server/index.js:
 * - `getIntegrationOperations` — `featureRoutesRuntime.getIntegrationOperations`;
 *   null before the routes are registered, which answers 503.
 *
 * Secrets stay with the user:
 * - Nothing here signs in or takes a token, password or client secret. Inputs
 *   holding a key named like one are refused before any operation runs.
 * - Every answer passes through `withoutSecrets`, which drops such keys at any
 *   depth. The operations already answer without them; this keeps it so if
 *   one of them changes.
 * - Signing out (removing an account, disconnecting Linear or an extension)
 *   and changing which credentials Git uses for a repository need `confirm`.
 *
 * GitLab instances are limited to gitlab.com and the ones already in the
 * credential store, so an agent cannot make the server probe an address the
 * user never connected.
 */
import { asNonEmptyString, isBoolean, isPlainObject, isString } from '../shared/guards.js';
import { normalizeGitLabInstance } from '../gitlab/instance.js';
import { OpenChamberControlError, asControlError } from './error.js';

export const INTEGRATION_SERVICE_ACTION_DEFINITIONS = Object.freeze([
  { action: 'integrations.list', title: 'List connected services', description: 'Overview of every connected service in one answer: GitHub and GitLab accounts, Linear workspaces, installed extensions with their sign-in state, and the source-control binding of directory. A section that cannot be read carries error; the others are still complete. Tokens are never returned' },
  { action: 'github.status', title: 'Show GitHub accounts', description: 'GitHub accounts OpenChamber holds, which one is current, and the gh CLI login (whether it is available, turned off, or the current account)' },
  { action: 'github.activate', title: 'Switch the GitHub account', description: 'Make accountId (from github.status) the current GitHub account; a github.com#cli: id switches to the gh CLI login' },
  { action: 'github.remove', title: 'Sign out of a GitHub account', description: 'Remove accountId (from github.status); repositories bound to it are marked as needing an account. For the gh CLI login it only stops using it. Needs confirm' },
  { action: 'github.cli', title: 'Turn the gh CLI login on or off', description: 'disabled true stops OpenChamber from offering the gh CLI login; false offers it again' },
  { action: 'gitlab.status', title: 'Show GitLab accounts', description: 'GitLab accounts per instance, which one is current, and the glab CLI login. instance picks one; without it every instance with stored accounts is listed' },
  { action: 'gitlab.activate', title: 'Switch the GitLab account', description: 'Make accountId (from gitlab.status) current on instance; an <instance>#cli: id switches to the glab login' },
  { action: 'gitlab.remove', title: 'Sign out of a GitLab account', description: 'Remove accountId on instance; repositories bound to it are marked as needing an account. Needs confirm' },
  { action: 'gitlab.cli', title: 'Turn the glab login on or off', description: 'disabled true stops OpenChamber from offering the glab login on instance; false offers it again' },
  { action: 'linear.status', title: 'Show Linear', description: 'Linear workspaces, the current one, which OpenChamber project each Linear team opens sessions in, and whether sessions post status comments on Linear issues' },
  { action: 'linear.activate', title: 'Switch the Linear workspace', description: 'Make workspaceId (from linear.status workspaces) current' },
  { action: 'linear.disconnect', title: 'Disconnect Linear', description: 'Revoke and remove the current Linear workspace; other workspaces and the project mapping stay. Needs confirm' },
  { action: 'linear.mapping', title: 'Map Linear teams to projects', description: 'Replace the current workspace\'s mapping with linearMapping: defaultProjectPath and teamProjectPaths (Linear team id to project path)' },
  { action: 'linear.preferences', title: 'Turn Linear session comments on or off', description: 'sessionComments true posts started, completed and failed comments with a session link on the linked Linear issue; false stops them' },
  { action: 'binding.get', title: 'Show a repository\'s source-control binding', description: 'Which provider, account and Git transport the repository at directory uses, with the revisions binding.set needs. Credentials appear as references, never as secrets' },
  { action: 'binding.set', title: 'Change a repository\'s source-control binding', description: 'Apply one change to the repository at directory: bindingOperation provider (which account a provider uses), transport or transport-remove (how one remote authenticates), auxiliary (a submodule or LFS endpoint), or reset; bindingIntent carries the same fields as the Git panel sends, including the expected revisions from binding.get. Everything but provider needs confirm' },
  { action: 'extensions.list', title: 'List installed extensions', description: 'Installed extensions with version, whether each is on, the capabilities it asked for and was given, what enterprise mode blocks, and for one with a service sign-in whether it is connected' },
  { action: 'extensions.get', title: 'Show one extension', description: 'Everything extensions.list says about extensionId, plus its sign-in state and setting values' },
  { action: 'extensions.toggle', title: 'Turn an extension on or off', description: 'disabled true pauses extensionId (its service stops, its panels close; sign-in and approvals stay); false turns it back on' },
  { action: 'extensions.settings', title: 'Change an extension\'s settings', description: 'Save extensionSettings (setting id to text) for extensionId; ids the extension does not declare are ignored' },
  { action: 'extensions.disconnect', title: 'Sign an extension out', description: 'Drop the sign-in tokens of extensionId; its settings and approvals stay. Needs confirm' },
]);

export const INTEGRATION_SERVICE_PARAMETERS = {
  accountId: { type: 'string', description: 'Account id from github.status or gitlab.status (accounts[].id)' },
  instance: { type: 'string', description: 'GitLab instance origin, such as https://gitlab.com; must be gitlab.com or one gitlab.status lists' },
  workspaceId: { type: 'string', description: 'Linear workspace id from linear.status (workspaces[].id)' },
  linearMapping: {
    type: 'object',
    description: 'linear.mapping: the whole mapping for the current workspace',
    properties: {
      defaultProjectPath: { type: 'string', description: 'Project path for teams without their own; empty clears it' },
      teamProjectPaths: { type: 'object', description: 'Linear team id to project path' },
    },
  },
  sessionComments: { type: 'boolean', description: 'linear.preferences: post session status comments on Linear issues' },
  bindingOperation: { type: 'string', enum: ['provider', 'transport', 'transport-remove', 'auxiliary', 'reset'], description: 'binding.set: which change bindingIntent describes' },
  bindingIntent: { type: 'object', description: 'binding.set: the change, with the expected repository, binding and config revisions from binding.get. Account and SSH key references only; raw tokens, passwords and URLs are refused' },
  extensionId: { type: 'string', description: 'Extension id from extensions.list' },
  extensionSettings: { type: 'object', description: 'extensions.settings: setting id to text value' },
};

const INTEGRATION_SERVICE_ACTIONS = INTEGRATION_SERVICE_ACTION_DEFINITIONS.map(({ action }) => action);

const GITLAB_DEFAULT_INSTANCE = 'https://gitlab.com';

/**
 * accessToken, refreshToken, clientSecret, password, apiKey, cookie and the
 * like. Anchored at the end so tokenType, scope and the binding's credential
 * references (which name a stored account, not a secret) stay.
 */
const SECRET_KEY = /(?:token|secret|password|passwd|passphrase|api[-_]?key|cookie|authorization)$/i;

const badRequest = (message) => new OpenChamberControlError(message, 400);

/** A copy of `value` with every secret-named key removed, at any depth. */
const withoutSecrets = (value) => {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_KEY.test(key))
    .map(([key, entry]) => [key, withoutSecrets(entry)]));
};

const findSecretKey = (value, path = '') => {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findSecretKey(entry, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  for (const [key, entry] of Object.entries(value)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (SECRET_KEY.test(key)) return keyPath;
    const found = findSecretKey(entry, keyPath);
    if (found) return found;
  }
  return null;
};

const refuseSecrets = (name, value) => {
  const found = findSecretKey(value);
  if (found) {
    throw badRequest(`${name}.${found} looks like a secret. Agents cannot enter tokens, passwords or client secrets; the user signs in or enters them in Settings`);
  }
};

const requireConfirm = (input, what) => {
  if (input.confirm !== true) {
    throw badRequest(`Nothing was changed. ${what}; repeat with confirm true only if the user explicitly asked for it`);
  }
};

const requireBoolean = (input, field, action) => {
  if (!isBoolean(input[field])) throw badRequest(`${field} (true or false) is required for ${action}`);
  return input[field];
};

/** Operation answers that are refusals become errors with the route's own status and message. */
const unwrap = ({ status, body }, describe = (message) => message) => {
  if (status >= 400) {
    const message = asNonEmptyString(body?.message) || asNonEmptyString(body?.error) || 'Request failed';
    throw new OpenChamberControlError(describe(message), status);
  }
  return body;
};

const settledSection = async (read) => {
  try {
    return await read();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

const BINDING_OPERATIONS = {
  provider: { run: 'setProvider', confirm: null },
  transport: { run: 'setTransport', confirm: 'This changes which credentials Git uses for a remote' },
  'transport-remove': { run: 'removeTransport', confirm: 'This removes the credentials Git uses for a remote' },
  auxiliary: { run: 'setAuxiliary', confirm: 'This changes which credentials Git uses for a submodule or LFS endpoint' },
  reset: { run: 'reset', confirm: 'This removes every provider and transport choice of the repository' },
};

export const createIntegrationServiceActions = (deps) => {
  const { getIntegrationOperations } = deps;

  const operations = () => {
    const found = getIntegrationOperations();
    if (!found) throw new OpenChamberControlError('Connected services are not available until the server has finished starting', 503);
    return found;
  };

  const resolveDirectory = (input, ctx) => asNonEmptyString(input.directory) || asNonEmptyString(ctx?.contextDirectory) || null;

  const requireAccountId = (input, action) => {
    const accountId = isString(input.accountId) ? input.accountId : '';
    if (!accountId.trim() || accountId.trim() !== accountId) throw badRequest(`accountId is required for ${action}; github.status or gitlab.status lists them`);
    return accountId;
  };

  // ---- GitHub

  const githubStatus = () => operations().github.status();

  const githubActivate = async (input) => unwrap(await operations().github.activate(requireAccountId(input, 'github.activate')));

  const githubRemove = async (input) => {
    const accountId = requireAccountId(input, 'github.remove');
    requireConfirm(input, `Removing ${accountId} signs the user out of that GitHub account`);
    return unwrap(await operations().github.remove(accountId));
  };

  const githubCli = (input) => operations().github.setCliDisabled(requireBoolean(input, 'disabled', 'github.cli'));

  // ---- GitLab

  const knownGitLabInstances = async () => {
    const stored = await operations().gitlab.listInstances();
    return [...new Set([GITLAB_DEFAULT_INSTANCE, ...stored])];
  };

  const requireInstance = async (input, action, { optional = false } = {}) => {
    const requested = asNonEmptyString(input.instance);
    if (!requested) {
      if (optional) return null;
      throw badRequest(`instance is required for ${action}`);
    }
    let origin;
    try {
      origin = normalizeGitLabInstance(requested);
    } catch {
      throw badRequest(`instance is not a valid GitLab address: ${requested}`);
    }
    const known = await knownGitLabInstances();
    if (!known.includes(origin)) {
      throw new OpenChamberControlError(`${origin} is not a GitLab instance the user connected. Known instances: ${known.join(', ')}. The user adds a new one by signing in from Settings`, 404);
    }
    return origin;
  };

  const gitlabStatus = async (input) => {
    const origin = await requireInstance(input, 'gitlab.status', { optional: true });
    if (origin) return operations().gitlab.status(origin);
    const stored = await operations().gitlab.listInstances();
    const instances = await Promise.all(stored.map((instance) => settledSection(() => operations().gitlab.status(instance))
      .then((status) => ({ instance, ...status }))));
    return { instances, note: stored.length ? undefined : 'No GitLab account is stored; the user signs in from Settings' };
  };

  const gitlabActivate = async (input) => {
    const origin = await requireInstance(input, 'gitlab.activate');
    return unwrap(await operations().gitlab.activate(origin, requireAccountId(input, 'gitlab.activate')));
  };

  const gitlabRemove = async (input) => {
    const origin = await requireInstance(input, 'gitlab.remove');
    const accountId = requireAccountId(input, 'gitlab.remove');
    requireConfirm(input, `Removing ${accountId} signs the user out of that GitLab account`);
    return unwrap(await operations().gitlab.remove(origin, accountId));
  };

  const gitlabCli = async (input) => {
    const origin = await requireInstance(input, 'gitlab.cli');
    return operations().gitlab.setCliDisabled(origin, requireBoolean(input, 'disabled', 'gitlab.cli'));
  };

  // ---- Linear

  const linearStatus = async () => {
    const { linear } = operations();
    const status = await linear.status();
    const result = { ...status };
    if (status.connected) {
      result.mapping = await settledSection(async () => unwrap(await linear.readMapping()));
    }
    result.preferences = await settledSection(() => linear.readPreferences());
    return result;
  };

  const linearActivate = async (input) => {
    const workspaceId = asNonEmptyString(input.workspaceId);
    if (!workspaceId) throw badRequest('workspaceId is required for linear.activate; linear.status lists them');
    return unwrap(await operations().linear.activate(workspaceId));
  };

  const linearDisconnect = async (input) => {
    requireConfirm(input, 'Disconnecting revokes the current Linear workspace\'s sign-in');
    return operations().linear.disconnect();
  };

  const linearMapping = async (input) => {
    if (!isPlainObject(input.linearMapping)) throw badRequest('linearMapping (defaultProjectPath, teamProjectPaths) is required for linear.mapping');
    refuseSecrets('linearMapping', input.linearMapping);
    return unwrap(await operations().linear.writeMapping(input.linearMapping));
  };

  const linearPreferences = async (input) => unwrap(
    await operations().linear.writePreferences(requireBoolean(input, 'sessionComments', 'linear.preferences')),
  );

  // ---- Source-control binding

  const requireDirectory = (input, ctx, action) => {
    const directory = resolveDirectory(input, ctx);
    if (!directory) throw badRequest(`directory is required for ${action}`);
    return directory;
  };

  const bindingGet = (input, ctx) => operations().bindings.read(requireDirectory(input, ctx, 'binding.get'));

  const bindingSet = async (input, ctx) => {
    const operation = BINDING_OPERATIONS[input.bindingOperation];
    if (!operation) throw badRequest(`bindingOperation must be one of: ${Object.keys(BINDING_OPERATIONS).join(', ')}`);
    if (!isPlainObject(input.bindingIntent)) throw badRequest('bindingIntent is required for binding.set; binding.get shows the revisions it needs');
    refuseSecrets('bindingIntent', input.bindingIntent);
    if (operation.confirm) requireConfirm(input, operation.confirm);
    const directory = requireDirectory({ directory: input.bindingIntent.directory ?? input.directory }, ctx, 'binding.set');
    return operations().bindings[operation.run]({ ...input.bindingIntent, directory });
  };

  // ---- Extensions

  const requireExtensionId = (input, action) => {
    const id = asNonEmptyString(input.extensionId);
    if (!id) throw badRequest(`extensionId is required for ${action}; extensions.list lists them`);
    return id;
  };

  const notFound = (id) => (message) => (message === 'not-found' ? `Extension not found: ${id}` : message);

  const summarizeExtension = (guest) => ({
    id: guest.id,
    name: guest.name,
    version: guest.version ?? null,
    source: guest.source ?? null,
    enabled: guest.enabled !== false,
    integration: guest.integration ? { name: guest.integration.name ?? null, auth: guest.integration.auth ?? null } : null,
    capabilities: guest.capabilities ?? null,
    enterpriseBlocked: guest.enterpriseBlocked ?? [],
  });

  const extensionsList = async () => {
    const { extensions } = operations();
    const { guests } = await extensions.list();
    return {
      extensions: await Promise.all(guests.map(async (guest) => {
        const summary = summarizeExtension(guest);
        if (guest.integration) {
          summary.signIn = await settledSection(async () => {
            const { connected, account } = unwrap(await extensions.authStatus(guest.id));
            return { connected, account };
          });
        }
        return summary;
      })),
    };
  };

  const extensionsGet = async (input) => {
    const id = requireExtensionId(input, 'extensions.get');
    const { extensions } = operations();
    const { guests } = await extensions.list();
    const guest = guests.find((entry) => entry.id === id);
    if (!guest) throw new OpenChamberControlError(`Extension not found: ${id}`, 404);
    return {
      ...guest,
      signIn: guest.integration ? unwrap(await extensions.authStatus(id), notFound(id)) : null,
    };
  };

  const extensionsToggle = async (input) => {
    const id = requireExtensionId(input, 'extensions.toggle');
    const disabled = requireBoolean(input, 'disabled', 'extensions.toggle');
    const { guest } = unwrap(await operations().extensions.setEnabled(id, { enabled: !disabled }), notFound(id));
    return { extension: summarizeExtension(guest) };
  };

  const extensionsSettings = async (input) => {
    const id = requireExtensionId(input, 'extensions.settings');
    if (!isPlainObject(input.extensionSettings)) throw badRequest('extensionSettings (setting id to text) is required for extensions.settings');
    refuseSecrets('extensionSettings', input.extensionSettings);
    return unwrap(await operations().extensions.saveSettings(id, input.extensionSettings), notFound(id));
  };

  const extensionsDisconnect = async (input) => {
    const id = requireExtensionId(input, 'extensions.disconnect');
    requireConfirm(input, `Disconnecting signs ${id} out of its service`);
    return unwrap(await operations().extensions.disconnect(id), notFound(id));
  };

  // ---- Overview

  const integrationsList = async (input, ctx) => {
    const directory = resolveDirectory(input, ctx);
    const [github, gitlab, linear, extensions, binding] = await Promise.all([
      settledSection(githubStatus),
      settledSection(() => gitlabStatus({})),
      settledSection(linearStatus),
      settledSection(extensionsList),
      directory ? settledSection(() => operations().bindings.read(directory)) : null,
    ]);
    const result = { github, gitlab, linear, extensions: extensions.extensions ?? extensions };
    if (binding) result.binding = { directory, ...binding };
    return result;
  };

  const handlers = {
    'integrations.list': integrationsList,
    'github.status': githubStatus,
    'github.activate': githubActivate,
    'github.remove': githubRemove,
    'github.cli': githubCli,
    'gitlab.status': gitlabStatus,
    'gitlab.activate': gitlabActivate,
    'gitlab.remove': gitlabRemove,
    'gitlab.cli': gitlabCli,
    'linear.status': linearStatus,
    'linear.activate': linearActivate,
    'linear.disconnect': linearDisconnect,
    'linear.mapping': linearMapping,
    'linear.preferences': linearPreferences,
    'binding.get': bindingGet,
    'binding.set': bindingSet,
    'extensions.list': extensionsList,
    'extensions.get': extensionsGet,
    'extensions.toggle': extensionsToggle,
    'extensions.settings': extensionsSettings,
    'extensions.disconnect': extensionsDisconnect,
  };

  const execute = async (action, input = {}, ctx = {}) => {
    const handler = handlers[action];
    if (!handler) throw badRequest(`Unsupported integration action: ${action || 'missing'}`);
    try {
      return withoutSecrets(await handler(input ?? {}, ctx));
    } catch (error) {
      throw asControlError(error, 'The connected service could not be read or changed');
    }
  };

  return { actions: INTEGRATION_SERVICE_ACTIONS, execute };
};
