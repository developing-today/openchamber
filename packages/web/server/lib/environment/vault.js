import { execFile as nodeExecFile } from 'node:child_process';

/**
 * Vault references in environment variables: a value such as
 * `op://Vertex SRE/github_token/credential` stands for a secret kept in
 * 1Password and is read with the `op` CLI (`op read`) when a process needs
 * it. The resolved value lives in memory only: it is never written, logged or
 * returned, and the variable's stored value stays the reference.
 *
 * A reference that cannot be read leaves its variable out, so a process
 * never receives the literal `op://` text as if it were the token, and the
 * failure is recorded per variable for Settings and the agent tool (the
 * reason, never `op`'s output, which can name vault items).
 */

// `op://<vault>/<item>/<field>` and the optional `<section>` level; names may contain spaces.
const OP_REFERENCE = /^op:\/\/[^/\s][^/]*\/[^/]+\/[^/]+(\/[^/]+)?$/;

export const isVaultReference = (value) => OP_REFERENCE.test(String(value ?? '').trim());

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TTL_MS = 5 * 60_000;

const readFailureReason = (error) => {
  if (error?.code === 'ENOENT') return 'op-not-installed';
  if (error?.killed || error?.signal === 'SIGTERM') return 'timeout';
  return 'op-read-failed';
};

/**
 * `resolve(variables, { refresh })` answers the variables with each vault
 * reference replaced by its secret, or left out when it cannot be read.
 * `refresh: true` reads a reference that has no value yet or one older than
 * `ttlMs`; `refresh: false` uses only what an earlier read left, so a caller
 * on a hot path (Git status polling) never starts `op`.
 */
export const createVaultResolver = ({
  execFile = nodeExecFile,
  env = () => process.env,
  now = Date.now,
  logger = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ttlMs = DEFAULT_TTL_MS,
} = {}) => {
  // reference -> { at, value }
  const values = new Map();
  const reads = new Map();
  // variable name -> { state: 'resolved' | 'failed', reason?, at }
  const statuses = new Map();
  const reported = new Set();

  const readReference = (reference) => {
    const pending = reads.get(reference);
    if (pending) return pending;
    const read = new Promise((resolve) => {
      execFile('op', ['read', '--no-newline', reference], { env: env(), timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) {
          resolve({ ok: false, reason: readFailureReason(error) });
          return;
        }
        const value = String(stdout ?? '');
        resolve(value ? { ok: true, value } : { ok: false, reason: 'empty' });
      });
    }).then((outcome) => {
      if (outcome.ok) values.set(reference, { at: now(), value: outcome.value });
      return outcome;
    }).finally(() => {
      reads.delete(reference);
    });
    reads.set(reference, read);
    return read;
  };

  const record = (name, outcome) => {
    statuses.set(name, outcome.ok ? { state: 'resolved', at: now() } : { state: 'failed', reason: outcome.reason, at: now() });
    if (!outcome.ok) {
      const message = `[environment] ${name} is a vault reference that could not be read (${outcome.reason}); it is left out`;
      if (!reported.has(message)) {
        reported.add(message);
        logger.warn(message);
      }
    }
  };

  const resolve = async (variables, { refresh = true } = {}) => {
    const entries = Object.entries(variables ?? {});
    if (!entries.some(([, value]) => isVaultReference(value))) return variables;
    const resolved = {};
    await Promise.all(entries.map(async ([name, value]) => {
      if (!isVaultReference(value)) {
        resolved[name] = value;
        return;
      }
      const reference = String(value).trim();
      const cached = values.get(reference);
      const fresh = cached && now() - cached.at < ttlMs;
      if (cached && (fresh || !refresh)) {
        resolved[name] = cached.value;
        return;
      }
      if (!refresh) return;
      const outcome = await readReference(reference);
      record(name, outcome);
      if (outcome.ok) resolved[name] = outcome.value;
      else if (cached) resolved[name] = cached.value;
    }));
    return resolved;
  };

  /** Per variable: the last read's outcome, or absent before any read. */
  const status = () => Object.fromEntries(statuses);

  return { resolve, status };
};
