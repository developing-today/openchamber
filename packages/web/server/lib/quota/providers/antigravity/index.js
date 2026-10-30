/**
 * Antigravity Quota Provider
 *
 * Dedicated quota provider for Google Cloud Code Antigravity IDE and proxy tools.
 * Supports dual-layer quotas: 5-Hour rolling limits and 7-Day weekly limits.
 * @module quota/providers/antigravity
 */

import { buildResult } from '../../utils/index.js';
import { readOpenCodeCredentials } from '../../../opencode/auth.js';
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
  try {
    const storeAuth = resolveAntigravityStoreAuth(await readOpenCodeCredentials());
    if (storeAuth && !candidates.some((candidate) => candidate.refreshToken === storeAuth.refreshToken)) {
      candidates.push(storeAuth);
    }
  } catch {
    // Credential store unwired or unreachable: the accounts file alone
    // decides, but the failure is kept — when it leaves no candidates it
    // must surface as its own error, not as "no login exists".
    storeReadFailed = true;
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
