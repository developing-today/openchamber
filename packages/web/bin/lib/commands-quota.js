import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { isJsonMode, isQuietMode, printJson } from '../cli-output.js';
import { asNonEmptyString } from '../../server/lib/shared/guards.js';

const DEFAULT_OPENCODE_PORT = 4096;

const QUOTA_HELP = `OpenChamber Quota Commands

USAGE:
  openchamber quota [PROVIDER ...] [OPTIONS]

  Without a PROVIDER, prints every provider with a usable credential.
  Providers OpenCode has turned off (disabled_providers) are left out;
  --all includes them.
  With one or more PROVIDER arguments, prints those providers in the
  order given. An argument may be a provider id (codex), its display
  name (Codex), or one of its credential aliases (chatgpt, copilot);
  matching ignores case. A provider named exactly this way is always
  fetched, even one OpenCode has turned off.
  An argument containing * or ? is a pattern. It expands, in catalogue
  order, to every configured provider whose id, display name, or alias
  matches, still leaving out turned off providers unless --all is set.
  An argument that resolves to nothing is a usage error.
  A provider with several stored credentials prints one block per
  credential, labeled with the credential and the account it metered.
  Quota is read from the running OpenCode, the same read the Usage page makes.

OUTPUT OPTIONS:
  --all                   Include providers OpenCode has turned off
  --json                  Output machine-readable JSON
  -q, --quiet             One compact line per credential

  The exit code is non-zero when a requested provider returned no
  successful result at all.

ENVIRONMENT:
  OPENCODE_HOST               OpenCode server base URL (default: http://127.0.0.1:4096)
  OPENCODE_PORT               OpenCode server port when OPENCODE_HOST is unset
  OPENCODE_SERVER_PASSWORD    Password of a secured OpenCode server
`;

// The web server resolves the OpenCode endpoint from its own runtime state.
// A standalone CLI read has only the external-OpenCode settings, so it uses
// OPENCODE_HOST when set and the default local serve address otherwise. The
// auth header matches server/lib/opencode/auth-state-runtime.js: Basic
// `opencode:<password>` from OPENCODE_SERVER_PASSWORD, no header when unset.
const resolveOpenCodeBaseUrl = (env) => {
  const host = asNonEmptyString(env.OPENCODE_HOST);
  if (host) return host.replace(/\/+$/, '');
  const port = Number.parseInt(env.OPENCODE_PORT ?? '', 10);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : DEFAULT_OPENCODE_PORT}`;
};

const buildOpenCodeAuthHeaders = (env) => {
  const password = asNonEmptyString(env.OPENCODE_SERVER_PASSWORD);
  if (!password) return {};
  return { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
};

const formatWindowValue = (window) => {
  if (Number.isFinite(window?.usedPercent)) {
    return `${window.usedPercent}% used`;
  }
  return asNonEmptyString(window?.valueLabel) ?? 'unknown';
};

const formatResultHeader = (result) => {
  const parts = [`${result.providerName} (${result.providerId})`];
  const credentialLabel = asNonEmptyString(result.credentialLabel);
  if (credentialLabel) {
    parts.push(credentialLabel);
  }
  const accountLabel = asNonEmptyString(result.accountLabel);
  if (accountLabel) {
    parts.push(accountLabel);
  }
  return parts.join(' — ');
};

const formatQuotaResultLines = (result) => {
  const header = formatResultHeader(result);
  if (!result.ok) {
    return [`${header}: ${result.error ?? 'Failed to fetch quota'}`];
  }
  const entries = Object.entries(result.usage?.windows ?? {});
  if (entries.length === 0) {
    return [`${header}: no usage windows reported`];
  }
  const lines = [header];
  for (const [label, window] of entries) {
    const resetAtFormatted = asNonEmptyString(window?.resetAtFormatted);
    const reset = resetAtFormatted ? `, resets ${resetAtFormatted}` : '';
    lines.push(`  ${label}: ${formatWindowValue(window)}${reset}`);
  }
  return lines;
};

const formatQuotaQuietLine = (result) => {
  const credentialLabel = asNonEmptyString(result.credentialLabel);
  const head = credentialLabel
    ? `${result.providerId}/${credentialLabel.replace(/\s+/g, '-')}`
    : result.providerId;
  if (!result.ok) {
    return `${head} error`;
  }
  const tokens = Object.entries(result.usage?.windows ?? {}).map(([label, window]) => {
    if (Number.isFinite(window?.usedPercent)) {
      return `${label}:${window.usedPercent}%`;
    }
    const valueLabel = asNonEmptyString(window?.valueLabel);
    return valueLabel ? `${label}:${valueLabel}` : `${label}:unknown`;
  });
  return [head, ...tokens].join(' ');
};

const defaultLoadQuotaRuntime = async () => {
  const [authModule, quotaModule] = await Promise.all([
    import('../../server/lib/opencode/auth.js'),
    import('../../server/lib/quota/index.js'),
  ]);
  return {
    configureOpenCodeCredentials: authModule.configureOpenCodeCredentials,
    openCodeCredentialSource: authModule.openCodeCredentialSource,
    listConfiguredQuotaProviders: quotaModule.listConfiguredQuotaProviders,
    listQuotaProviderCatalogue: quotaModule.listQuotaProviderCatalogue,
    fetchQuotaForProviderInstances: quotaModule.fetchQuotaForProviderInstances,
  };
};

const hasWildcard = (token) => token.includes('*') || token.includes('?');

const escapeRegExpChar = (char) => ('.*+^${}()|[]\\'.includes(char) ? `\\${char}` : char);

const wildcardToRegExp = (pattern) => new RegExp(
  `^${[...pattern].map((char) => (char === '*' ? '.*' : char === '?' ? '.' : escapeRegExpChar(char))).join('')}$`,
  'i'
);

/**
 * Resolve one run's provider arguments to provider ids, in argument
 * order, duplicates removed. An argument without wildcard characters
 * resolves exactly (provider id, then display name, then credential
 * alias; matching ignores case) and is explicit: it is fetched even when
 * the provider is turned off or holds no credential. A wildcard pattern
 * expands, in catalogue order, over the configured providers only, and
 * leaves out the turned off ones unless `includeDisabled` is set. An
 * argument that resolves to nothing throws a usage error before anything
 * is fetched.
 */
const resolveQuotaProviderArgs = ({ args, catalogue, configuredIds, includeDisabled }) => {
  const resolved = [];
  const seen = new Set();
  const push = (id) => {
    if (!seen.has(id)) {
      seen.add(id);
      resolved.push(id);
    }
  };

  for (const arg of args) {
    if (hasWildcard(arg)) {
      const matcher = wildcardToRegExp(arg);
      const matches = catalogue.filter((entry) => configuredIds.has(entry.id)
        && (includeDisabled || !entry.disabled)
        && (matcher.test(entry.id) || matcher.test(entry.name) || entry.aliases.some((alias) => matcher.test(alias))));
      if (matches.length === 0) {
        throw new TunnelCliError(`No configured quota provider matches '${arg}'.`, EXIT_CODE.USAGE_ERROR);
      }
      for (const entry of matches) push(entry.id);
      continue;
    }
    const needle = arg.toLowerCase();
    const exact = catalogue.find((entry) => entry.id.toLowerCase() === needle)
      ?? catalogue.find((entry) => entry.name.toLowerCase() === needle)
      ?? catalogue.find((entry) => entry.aliases.some((alias) => alias.toLowerCase() === needle));
    if (!exact) {
      throw new TunnelCliError(`Unknown quota provider '${arg}'.`, EXIT_CODE.USAGE_ERROR);
    }
    push(exact.id);
  }
  return resolved;
};

const normalizeProviderArgs = (providerArg) => {
  if (Array.isArray(providerArg)) {
    return providerArg.flatMap((token) => {
      const value = asNonEmptyString(token);
      return value ? [value] : [];
    });
  }
  const single = asNonEmptyString(providerArg);
  return single ? [single] : [];
};

function createQuotaCommand({ loadQuotaRuntime = defaultLoadQuotaRuntime, env = process.env } = {}) {
  return async function quotaCommand(options = {}, providerArg = null) {
    const args = normalizeProviderArgs(providerArg);
    if (args.length === 1 && args[0] === 'help') {
      process.stdout.write(QUOTA_HELP);
      return;
    }

    const runtime = await loadQuotaRuntime();
    runtime.configureOpenCodeCredentials(runtime.openCodeCredentialSource({
      buildOpenCodeUrl: (requestPath) => `${resolveOpenCodeBaseUrl(env)}${requestPath ?? ''}`,
      getOpenCodeAuthHeaders: () => buildOpenCodeAuthHeaders(env),
    }));

    let results;
    let requestedIds = null;
    if (args.length > 0) {
      const catalogue = await runtime.listQuotaProviderCatalogue();
      const configured = await runtime.listConfiguredQuotaProviders({ includeDisabled: true });
      requestedIds = resolveQuotaProviderArgs({
        args,
        catalogue,
        configuredIds: new Set(configured),
        includeDisabled: Boolean(options.all),
      });
      const groups = [];
      for (const id of requestedIds) {
        groups.push(await runtime.fetchQuotaForProviderInstances(id));
      }
      results = groups.flat();
    } else {
      const configured = await runtime.listConfiguredQuotaProviders({ includeDisabled: Boolean(options.all) });
      const groups = await Promise.all(configured.map((id) => runtime.fetchQuotaForProviderInstances(id)));
      results = groups.flat();
    }

    if (isJsonMode(options)) {
      printJson({ providers: results });
    } else if (isQuietMode(options)) {
      if (results.length === 0) {
        process.stdout.write('none configured\n');
      } else {
        for (const result of results) {
          process.stdout.write(`${formatQuotaQuietLine(result)}\n`);
        }
      }
    } else if (results.length === 0) {
      process.stdout.write('No quota providers configured.\n');
    } else {
      process.stdout.write(`${results.flatMap(formatQuotaResultLines).join('\n')}\n`);
    }

    if (requestedIds && requestedIds.some((id) => !results.some((result) => result.providerId === id && result.ok))) {
      process.exitCode = EXIT_CODE.GENERAL_ERROR;
    }
  };
}

export {
  createQuotaCommand,
  resolveOpenCodeBaseUrl,
  buildOpenCodeAuthHeaders,
  formatQuotaResultLines,
  formatQuotaQuietLine,
};
