/**
 * Antigravity Quota Provider
 *
 * Dedicated quota provider for Google Cloud Code Antigravity IDE and proxy tools.
 * Supports dual-layer quotas: 5-Hour rolling limits and 7-Day weekly limits.
 * @module quota/providers/antigravity
 */

import { buildResult } from '../../utils/index.js';
import { credentialSourceUsesLocalStore, readLocalOpenCodeCredentials, readOpenCodeCredentials } from '../../../opencode/auth.js';
import { resolveAntigravityAuth, resolveAntigravityStoreAuth, isConfigured, DEFAULT_PROJECT_ID } from './auth.js';
import {
  refreshAntigravityToken,
  fetchAntigravityModels,
  fetchAntigravityQuotaSummary
} from './api.js';
import { transformSummary, transformModels } from './transforms.js';
import { warnIfGeminiGroupMissing } from './client.js';

export { isConfigured } from './auth.js';

export const providerId = 'antigravity';
export const providerName = 'Antigravity';

const resolveAuthCandidates = async () => {
  const candidates = [];
  const fileAuth = resolveAntigravityAuth();
  if (fileAuth) {
    candidates.push(fileAuth);
  }
  let storeReadFailed = false;
  const pushStoreAuth = (auth) => {
    const storeAuth = resolveAntigravityStoreAuth(auth);
    if (storeAuth && !candidates.some((candidate) => candidate.refreshToken === storeAuth.refreshToken)) {
      candidates.push(storeAuth);
    }
  };
  try {
    pushStoreAuth(await readOpenCodeCredentials());
  } catch {
    // Credential store unwired or unreachable: the accounts file alone
    // decides, but the failure is kept — when it leaves no candidates it
    // must surface as its own error, not as "no login exists".
    storeReadFailed = true;
  }
  if (!candidates.length && credentialSourceUsesLocalStore()) {
    // The projection the running OpenCode serves can withhold the refresh
    // token this provider must present (the stored-login projection keeps
    // refresh tokens with OpenCode), leaving a signed-in user reading as
    // "Not configured". Read the credential store directly instead — the
    // fallback the quota CLI already uses — but only when the connected
    // OpenCode is known to use this machine's store: an external OpenCode
    // reached through OPENCODE_HOST can belong to another machine, and its
    // successful empty read must stand rather than be overridden by an
    // unrelated local login (Codex review on PR #860). Best-effort: a
    // store that is absent or unreadable on this machine decides nothing,
    // so a failure
    // here neither adds a candidate nor manufactures an error state; the
    // accounts file and the served read above have already spoken.
    try {
      pushStoreAuth(await readLocalOpenCodeCredentials());
    } catch {
      // No readable local credential store: the candidates above stand.
    }
  }
  return { candidates, storeReadFailed };
};

export const fetchQuota = async () => {
  const { candidates, storeReadFailed } = await resolveAuthCandidates();
  if (!candidates.length) {
    if (storeReadFailed) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Failed to read OpenCode credential store'
      });
    }
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  let accessToken = null;
  let auth = null;
  for (const candidate of candidates) {
    accessToken = await refreshAntigravityToken(candidate.refreshToken);
    if (accessToken) {
      auth = candidate;
      break;
    }
  }
  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: 'Failed to refresh Antigravity token'
    });
  }

  const projectId = auth.projectId ?? DEFAULT_PROJECT_ID;

  const [summaryPayload, modelsPayload] = await Promise.all([
    fetchAntigravityQuotaSummary(accessToken, projectId),
    fetchAntigravityModels(accessToken, projectId)
  ]);

  warnIfGeminiGroupMissing(summaryPayload);
  const { modelGroupWindows } = transformSummary(summaryPayload);
  const models = transformModels(modelsPayload, modelGroupWindows);

  if (!Object.keys(models).length) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: 'Failed to fetch Antigravity quota'
    });
  }

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: {
      windows: {},
      models: Object.keys(models).length ? models : undefined
    }
  });
};
