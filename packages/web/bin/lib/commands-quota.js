import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { isJsonMode, isQuietMode, printJson } from '../cli-output.js';
import { asNonEmptyString } from '../../server/lib/shared/guards.js';

const DEFAULT_OPENCODE_PORT = 4096;

// A whole number from the environment, else null. Only a plain decimal
// spelling counts: a bare parseInt would read '1e3' as 1, '4096junk' as
// 4096, and '10.9' as 10. Same strict judgement as parsePlainDecimalInt in
// server/lib/fs/routes.js and the whole-text checks in cli-args.js.
const parsePlainDecimalInt = (raw) => {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

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
  When no OpenCode server answers, credentials are read from OpenCode's
  local store on this machine instead; every result then names the
  source that served it (credentialSource in --json, a note on stderr
  otherwise), and one provider's failure or timeout never hides the rest.

OUTPUT OPTIONS:
  --all                   Include providers OpenCode has turned off
  --json                  Output machine-readable JSON
  -q, --quiet             One compact line per credential

  The exit code is non-zero when a requested provider returned no
  successful result at all.

ENVIRONMENT:
  OPENCODE_HOST                   OpenCode server base URL (default: http://127.0.0.1:4096)
  OPENCODE_PORT                   OpenCode server port when OPENCODE_HOST is unset
  OPENCODE_SERVER_PASSWORD        Password of a secured OpenCode server
  OPENCHAMBER_QUOTA_TIMEOUT_MS    Per-provider fetch timeout in milliseconds (default: 10000)
`;

// The web server resolves the OpenCode endpoint from its own runtime state.
// A standalone CLI read has only the external-OpenCode settings, so it uses
// OPENCODE_HOST when set and the default local serve address otherwise. The
// auth header matches server/lib/opencode/auth-state-runtime.js: Basic
// `opencode:<password>` from OPENCODE_SERVER_PASSWORD, no header when unset.
const resolveOpenCodeBaseUrl = (env) => {
  const host = asNonEmptyString(env.OPENCODE_HOST);
  if (host) return host.replace(/\/+$/, '');
  const port = parsePlainDecimalInt(env.OPENCODE_PORT);
  return `http://127.0.0.1:${port !== null && port >= 1 && port <= 65535 ? port : DEFAULT_OPENCODE_PORT}`;
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
  lines.push(...formatModelBreakdownLines(result.usage?.models));
  return lines;
};

const formatAmount = (value) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100));

// Per-model detail a provider attached to the result (Open Design usage
// records), printed as an indented block under the provider's windows. Each
// segment appears only when the provider reported that field.
const formatModelBreakdownLines = (models) => {
  if (!Array.isArray(models) || models.length === 0) {
    return [];
  }
  const lines = ['  models:'];
  for (const entry of models) {
    const segments = [];
    if (Number.isFinite(entry?.credits)) segments.push(`${formatAmount(entry.credits)} credits`);
    if (Number.isFinite(entry?.sharePercent)) segments.push(`${formatAmount(entry.sharePercent)}% share`);
    if (Number.isFinite(entry?.totalTokens) && entry.totalTokens > 0) segments.push(`${entry.totalTokens} tokens`);
    if (Number.isFinite(entry?.multiplier)) segments.push(`${formatAmount(entry.multiplier)}x multiplier`);
    const model = asNonEmptyString(entry?.model) ?? 'unknown model';
    lines.push(segments.length > 0 ? `    ${model}: ${segments.join(', ')}` : `    ${model}`);
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
    openCodeLocalCredentialSource: authModule.openCodeLocalCredentialSource,
    listConfiguredQuotaProviders: quotaModule.listConfiguredQuotaProviders,
    listQuotaProviderCatalogue: quotaModule.listQuotaProviderCatalogue,
    fetchQuotaForProviderInstances: quotaModule.fetchQuotaForProviderInstances,
  };
};

const TRANSPORT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
]);

/**
 * Whether a credential read failed because OpenCode could not be reached
 * at all, as opposed to the server answering and refusing. The OpenCode
 * client marks its own transport failures with `reason: 'Transport'` (an
 * HTTP answer is a different reason and stays authoritative); the walk
 * down the cause chain covers the fetch and socket errors underneath.
 */
const isTransportFailure = (error) => {
  let current = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current.reason === 'Transport') return true;
    if (TRANSPORT_ERROR_CODES.has(asNonEmptyString(current.code) ?? '')) return true;
    const message = asNonEmptyString(current.message) ?? '';
    if (message.startsWith('Transport:') || message === 'fetch failed') return true;
    current = current.cause;
  }
  return false;
};

/**
 * The server credential source with the local store behind it. The first
 * transport failure switches every later read in the run to the local
 * store — a server that is down does not come back mid-run — and
 * `servedBy()` reports which source the run's reads came from, so the
 * output never presents a store read as a live server read. Writes and
 * the launch environment always stay with the server source.
 * `usesLocalStore()` forwards the server source's answer, so a resolver
 * that gates a direct store read on a known-local source (the
 * Antigravity fallback) works through this combined source too; the
 * server source only claims local for a managed or loopback OpenCode,
 * so a remote server is never answered with this machine's store.
 */
const createFallbackCredentialSource = (primary, fallback) => {
  let fellBack = false;
  const source = {
    servedBy: () => (fellBack ? 'local' : 'server'),
    usesLocalStore: () => primary.usesLocalStore?.() ?? false,
    list: async () => {
      if (fellBack) return fallback.list();
      try {
        return await primary.list();
      } catch (error) {
        if (!isTransportFailure(error)) throw error;
        fellBack = true;
        try {
          return await fallback.list();
        } catch (fallbackError) {
          const reason = error instanceof Error ? error.message : 'OpenCode server unreachable';
          const storeReason = fallbackError instanceof Error ? fallbackError.message : 'local credential store unreadable';
          throw new Error(`${reason}; the local credential store could not be read either (${storeReason})`);
        }
      }
    },
  };
  if (primary.create) source.create = (input) => primary.create(input);
  if (primary.remove) source.remove = (credentialID) => primary.remove(credentialID);
  if (primary.listEnvironmentKeys) source.listEnvironmentKeys = () => primary.listEnvironmentKeys();
  return source;
};

const QUOTA_FETCH_CONCURRENCY = 6;
const DEFAULT_QUOTA_TIMEOUT_MS = 10_000;

const resolveQuotaTimeoutMs = (env) => {
  const parsed = parsePlainDecimalInt(env.OPENCHAMBER_QUOTA_TIMEOUT_MS);
  // The value feeds setTimeout, which cannot honour more than 2^31-1 ms: a
  // larger duration overflows to ~1 ms and every fetch instantly 'times out'.
  // Fall back to the default instead, the bound createGitExecTimeoutMs uses.
  return parsed !== null && parsed > 0 && parsed <= 2_147_483_647 ? parsed : DEFAULT_QUOTA_TIMEOUT_MS;
};

/** Runs `worker` over `items` with at most `limit` in flight; results keep input order. */
const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return results;
};

/**
 * One provider's results with its elapsed time attached. A provider that
 * outlives the timeout answers a `status: 'timeout'` row instead of
 * holding the whole run; a dispatcher throw answers an error row for
 * that provider alone. Either way the batch completes.
 */
const fetchProviderWithTimeout = async (runtime, providerId, providerName, timeoutMs) => {
  const startedAt = Date.now();
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const results = await Promise.race([runtime.fetchQuotaForProviderInstances(providerId), deadline]);
    if (results === null) {
      return [{
        providerId,
        providerName,
        ok: false,
        configured: true,
        usage: null,
        error: `Quota fetch timed out after ${timeoutMs} ms`,
        status: 'timeout',
        fetchedAt: startedAt,
        elapsedMs: Date.now() - startedAt,
      }];
    }
    const elapsedMs = Date.now() - startedAt;
    return results.map((result) => ({ ...result, elapsedMs }));
  } catch (error) {
    return [{
      providerId,
      providerName,
      ok: false,
      configured: true,
      usage: null,
      error: error instanceof Error ? error.message : 'Request failed',
      fetchedAt: startedAt,
      elapsedMs: Date.now() - startedAt,
    }];
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const fetchProviders = async (runtime, providerIds, catalogue, timeoutMs) => {
  const nameById = new Map(catalogue.map((entry) => [entry.id, entry.name]));
  const groups = await mapWithConcurrency(providerIds, QUOTA_FETCH_CONCURRENCY, (id) =>
    fetchProviderWithTimeout(runtime, id, nameById.get(id) ?? id, timeoutMs));
  return groups.flat();
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
    const serverSource = runtime.openCodeCredentialSource({
      buildOpenCodeUrl: (requestPath) => `${resolveOpenCodeBaseUrl(env)}${requestPath ?? ''}`,
      getOpenCodeAuthHeaders: () => buildOpenCodeAuthHeaders(env),
    });
    const credentialSource = createFallbackCredentialSource(serverSource, runtime.openCodeLocalCredentialSource());
    runtime.configureOpenCodeCredentials(credentialSource);
    const timeoutMs = resolveQuotaTimeoutMs(env);

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
      results = await fetchProviders(runtime, requestedIds, catalogue, timeoutMs);
    } else {
      const configured = await runtime.listConfiguredQuotaProviders({ includeDisabled: Boolean(options.all) });
      const catalogue = await runtime.listQuotaProviderCatalogue();
      results = await fetchProviders(runtime, configured, catalogue, timeoutMs);
    }

    const credentialSourceName = credentialSource.servedBy();
    results = results.map((result) => ({ ...result, credentialSource: credentialSourceName }));

    if (credentialSourceName === 'local' && !isJsonMode(options)) {
      process.stderr.write('note: the OpenCode server was unreachable, so credentials came from the local OpenCode store.\n');
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
  isTransportFailure,
  createFallbackCredentialSource,
  resolveQuotaTimeoutMs,
};
