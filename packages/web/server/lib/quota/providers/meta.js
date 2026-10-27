/**
 * Meta Model API (Muse Code High Usage plan) quota.
 *
 * Data source: `POST https://api.meta.ai/muse-code/key` with
 * `x-api-version: 1.0.0` and body `{ "onboard": false }`. The response carries
 * the plan's own usage view:
 *
 *   subs_usage.window  { used_percent, window_duration_mins, resets_at }
 *   subs_usage.weekly  { used_percent, resets_at }
 *   subs_tier_name     (for example "Muse Code High Usage")
 *
 * That is the endpoint Meta's own Muse Code CLI reads for `/usage`; Meta
 * publishes no separate usage REST route. The rolling `window` becomes a
 * duration-labelled window (`window_duration_mins` × 60 → `5h`, …) and
 * `weekly` becomes the `weekly` window. `subs_tier_name` is surfaced as
 * `planLabel`.
 *
 * Credential sourcing (and its limits):
 *   The plan-usage read authenticates with the Meta *account* OAuth access
 *   token (the Muse Code device-login token, `dca:…`), not with the
 *   subscription's minted inference API key: the key endpoint refuses a minted
 *   key with 401. The OpenCode `meta` credential is preferred, so an install
 *   that stores the account token there works directly. When OpenCode holds the
 *   minted inference key (the fleet's case: `META_API_KEY` is the `LLM|…` key
 *   the key endpoint mints), that read is rejected and the provider falls back
 *   to the account token in the Muse CLI's own OAuth store
 *   (`~/.config/muse/auth.json`, `providers.meta.access_token`) — the same login
 *   the fleet's muse-proxy uses for this pool. The token is read at fetch time
 *   and never logged.
 *
 * Failure classes stay distinct:
 *   - not configured (no credential),
 *   - unauthorized (the credential the read used is not an account token),
 *   - subscription inactive (`is_subs_active === false`),
 *   - a 402-class wall or a 429 (an exhausted plan, `require_payment`, or a
 *     rate-limited usage read) as `ok: false, quotaExhausted: true` with the
 *     reset when the body carries one — a wall the babysitter must not confuse
 *     with a read failure,
 *   - malformed response and transport failure.
 *
 * Keep this in sync with `packages/vscode/src/quotaProviders.ts` (`fetchMetaQuota`).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  resolveWindowLabel,
  asObject,
  asNonEmptyString
} from '../utils/index.js';

export const providerId = 'meta';
export const providerName = 'Meta Model API';
export const aliases = ['meta'];

const META_KEY_URL = 'https://api.meta.ai/muse-code/key';
const WEEKLY_SECONDS = 7 * 24 * 60 * 60;
// The Muse CLI's own login store. Read-only; the token is never written back.
const MUSE_AUTH_PATH = path.join(os.homedir(), '.config', 'muse', 'auth.json');

/** The Meta account OAuth token from the Muse CLI's login store, or null. */
export const readMuseAccountToken = ({ filePath = MUSE_AUTH_PATH } = {}) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return asNonEmptyString(parsed?.providers?.meta?.access_token);
  } catch {
    return null;
  }
};

// An account OAuth token is what the key endpoint wants. A `key`/`token` entry
// is the minted inference key in the common case, but is still tried first so a
// store that keeps the account token under `key` works without the fallback.
const accountTokenFromEntry = (entry) => asNonEmptyString(entry?.access)
  ?? asNonEmptyString(entry?.accessToken)
  ?? asNonEmptyString(entry?.oauthAccessToken);

const keyFromEntry = (entry) => asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);

export const isConfigured = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(accountTokenFromEntry(entry) || keyFromEntry(entry));
};

/** The reset instant and window name from a 402/429 body, when it carries them. */
const readQuotaErrorDetail = (body) => {
  const quota = asObject(body?.quota);
  const resetRaw = quota?.resetsAtMs
    ?? quota?.resets_at
    ?? quota?.resetsAt
    ?? body?.resetsAtMs
    ?? body?.resets_at;
  return {
    resetAt: toTimestamp(resetRaw),
    limitKind: asNonEmptyString(quota?.limitKind)
      ?? asNonEmptyString(quota?.limit_kind)
      ?? asNonEmptyString(body?.limitKind)
      ?? null,
    tier: asNonEmptyString(quota?.tier) ?? asNonEmptyString(body?.tier) ?? null
  };
};

const errorMessage = (body) => asNonEmptyString(asObject(body?.error)?.message)
  ?? asNonEmptyString(body?.message)
  ?? asNonEmptyString(body?.detail)
  ?? null;

/**
 * One plan-usage read. Answers the HTTP outcome rather than a built result so
 * the caller can decide whether a rejection is worth retrying with another
 * credential.
 */
const requestPlanUsage = async (bearer, fetchImpl) => {
  const timeoutSignal = AbortSignal.timeout(15_000);
  let response;
  try {
    response = await fetchImpl(META_KEY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-version': '1.0.0'
      },
      body: JSON.stringify({ onboard: false }),
      signal: timeoutSignal
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    return {
      kind: 'error',
      message: isTimeout
        ? 'Request timed out'
        : error instanceof SyntaxError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed')
    };
  }

  const readBody = async () => {
    try {
      return asObject(await response.json());
    } catch {
      return null;
    }
  };

  if (response.status === 401 || response.status === 403) {
    return { kind: 'unauthorized', status: response.status };
  }

  if (response.status === 402 || response.status === 429) {
    const body = await readBody();
    return { kind: 'exhausted', ...readQuotaErrorDetail(body), message: errorMessage(body) };
  }

  if (!response.ok) {
    return { kind: 'error', message: `API error: ${response.status}` };
  }

  const body = await readBody();
  if (!body) {
    return { kind: 'error', message: 'Invalid response from provider' };
  }

  if (body.is_subs_active === false) {
    return { kind: 'inactive' };
  }

  // A payment demand is the plan's own wall, not a read failure.
  if (body.require_payment === true) {
    return { kind: 'exhausted', ...readQuotaErrorDetail(body), message: errorMessage(body) };
  }

  return { kind: 'usage', body };
};

const buildWindows = (subsUsage) => {
  const windows = {};

  const rolling = asObject(subsUsage?.window);
  if (rolling) {
    const durationMinutes = toNumber(rolling.window_duration_mins);
    const windowSeconds = durationMinutes !== null && durationMinutes > 0 ? durationMinutes * 60 : null;
    windows[windowSeconds ? resolveWindowLabel(windowSeconds) : 'rolling'] = toUsageWindow({
      usedPercent: toNumber(rolling.used_percent),
      windowSeconds,
      resetAt: toTimestamp(rolling.resets_at)
    });
  }

  const weekly = asObject(subsUsage?.weekly);
  if (weekly) {
    windows.weekly = toUsageWindow({
      usedPercent: toNumber(weekly.used_percent),
      windowSeconds: WEEKLY_SECONDS,
      resetAt: toTimestamp(weekly.resets_at)
    });
  }

  return windows;
};

const usageResult = (body) => {
  const windows = buildWindows(asObject(body.subs_usage));
  if (Object.keys(windows).length === 0) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: 'No quota data in response'
    });
  }

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    planLabel: asNonEmptyString(body.subs_tier_name) ?? undefined,
    usage: { windows },
    accountLabel: asNonEmptyString(body.user_email) ?? undefined
  });
};

const exhaustedResult = ({ resetAt, limitKind, tier, message }) => {
  const detail = message && message !== 'Subscription quota exhausted' ? `: ${message}` : '';
  return {
    ...buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: `Subscription quota exhausted${detail}`,
      planLabel: tier ?? undefined
    }),
    quotaExhausted: true,
    quotaResetAt: resetAt,
    quotaLimitKind: limitKind
  };
};

const unauthorizedResult = () => buildResult({
  providerId,
  providerName,
  ok: false,
  configured: true,
  error: 'Meta plan usage needs the account login — sign in with the Muse Code CLI or store its account token'
});

const inactiveResult = () => buildResult({
  providerId,
  providerName,
  ok: false,
  configured: true,
  error: 'Meta subscription is inactive'
});

const outcomeToResult = (outcome) => {
  if (outcome.kind === 'exhausted') return exhaustedResult(outcome);
  if (outcome.kind === 'inactive') return inactiveResult();
  if (outcome.kind === 'error') {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: outcome.message
    });
  }
  if (outcome.kind === 'usage') return usageResult(outcome.body);
  return unauthorizedResult();
};

export const fetchQuota = async ({
  readAuth = readOpenCodeCredentials,
  readAccountToken = readMuseAccountToken,
  fetchImpl = fetch
} = {}) => {
  const entry = normalizeAuthEntry(getAuthEntry(await readAuth(), aliases));
  const primary = accountTokenFromEntry(entry) ?? keyFromEntry(entry);

  if (!primary) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const first = await requestPlanUsage(primary, fetchImpl);
  if (first.kind !== 'unauthorized') return outcomeToResult(first);

  // OpenCode holds a credential the key endpoint refuses (the minted inference
  // key). The account token the read needs lives in the Muse CLI's login store.
  const fallback = readAccountToken?.() ?? null;
  if (!fallback || fallback === primary) return unauthorizedResult();

  return outcomeToResult(await requestPlanUsage(fallback, fetchImpl));
};
