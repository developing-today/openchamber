/**
 * Quota Providers Registry
 *
 * Implements quota fetching for various AI providers using a registry pattern.
 * @module quota/providers
 */

import { listStoredCredentials, readOpenCodeCredentials } from '../../opencode/auth.js';
import { readConfigLayers } from '../../opencode/shared.js';
import { isRecord } from '../../opencode/config-v2.js';
import { asNonEmptyString, buildResult } from '../utils/index.js';

import * as claude from './claude/index.js';
import * as clinePass from './cline-pass.js';
import * as codex from './codex.js';
import * as copilot from './copilot.js';
import * as cursor from './cursor.js';
import * as deepinfra from './deepinfra.js';
import * as deepseek from './deepseek.js';
import * as exeDev from './exe-dev.js';
import * as google from './google/index.js';
import * as antigravity from './antigravity/index.js';
import * as hyper from './hyper.js';
import * as kimi from './kimi.js';
import * as nanogpt from './nanogpt.js';
import * as openai from './openai.js';
import * as openrouter from './openrouter.js';
import * as zai from './zai.js';
import * as zhipuaiCodingPlan from './zhipuai-coding-plan.js';
import * as minimaxCodingPlan from './minimax-coding-plan.js';
import * as minimaxCnCodingPlan from './minimax-cn-coding-plan.js';
import * as neuralwatt from './neuralwatt.js';
import * as opendesign from './opendesign.js';
import * as kilo from './kilo.js';
import * as zenmux from './zenmux.js';
import * as ollamaCloud from './ollama-cloud.js';
import * as wafer from './wafer.js';
import * as opencodeGo from './opencode-go.js';
import * as xai from './xai.js';

// Providers whose fetcher accepts an injected credential read can fetch for
// one stored credential: the injected read answers that credential's row
// alone, keyed by its own integration id.
const fetchWithCredentialRead = (fetchQuota) => async (credential) => {
  const readAuth = async () => ({ [credential.integrationID]: credential.value });
  return fetchQuota({ readAuth, readCredentials: readAuth });
};

const registry = {
  claude: {
    providerId: claude.providerId,
    providerName: claude.providerName,
    aliases: claude.aliases,
    isConfigured: claude.isConfigured,
    fetchQuota: claude.fetchQuota
  },
  'cline-pass': {
    providerId: clinePass.providerId,
    providerName: clinePass.providerName,
    aliases: clinePass.aliases,
    isConfigured: clinePass.isConfigured,
    fetchQuota: clinePass.fetchQuota,
    credentialAliases: ['cline-pass'],
    fetchQuotaForCredential: fetchWithCredentialRead(clinePass.fetchQuota)
  },
  codex: {
    providerId: codex.providerId,
    providerName: codex.providerName,
    aliases: codex.aliases,
    isConfigured: codex.isConfigured,
    fetchQuota: codex.fetchQuota,
    credentialAliases: ['openai', 'codex', 'chatgpt'],
    fetchQuotaForCredential: codex.fetchQuotaForCredential
  },
  cursor: {
    providerId: cursor.providerId,
    providerName: cursor.providerName,
    aliases: cursor.aliases,
    isConfigured: cursor.isConfigured,
    fetchQuota: cursor.fetchQuota
  },
  deepinfra: {
    providerId: deepinfra.providerId,
    providerName: deepinfra.providerName,
    aliases: deepinfra.aliases,
    isConfigured: deepinfra.isConfigured,
    fetchQuota: deepinfra.fetchQuota,
    credentialAliases: ['deepinfra', 'deep-infra', 'deep_infra'],
    fetchQuotaForCredential: fetchWithCredentialRead(deepinfra.fetchQuota)
  },
  deepseek: {
    providerId: deepseek.providerId,
    providerName: deepseek.providerName,
    aliases: deepseek.aliases,
    isConfigured: deepseek.isConfigured,
    fetchQuota: deepseek.fetchQuota
  },
  'exe-dev': {
    providerId: exeDev.providerId,
    providerName: exeDev.providerName,
    aliases: exeDev.aliases,
    isConfigured: exeDev.isConfigured,
    fetchQuota: exeDev.fetchQuota
  },
  google: {
    providerId: google.providerId,
    providerName: google.providerName,
    aliases: google.aliases,
    isConfigured: google.isConfigured,
    fetchQuota: google.fetchGoogleQuota
  },
  antigravity: {
    providerId: antigravity.providerId,
    providerName: antigravity.providerName,
    aliases: antigravity.aliases,
    isConfigured: antigravity.isConfigured,
    fetchQuota: antigravity.fetchQuota
  },
  hyper: {
    providerId: hyper.providerId,
    providerName: hyper.providerName,
    aliases: hyper.aliases,
    isConfigured: hyper.isConfigured,
    fetchQuota: hyper.fetchQuota,
    credentialAliases: ['hyper'],
    fetchQuotaForCredential: fetchWithCredentialRead(hyper.fetchQuota)
  },
  'zai-coding-plan': {
    providerId: zai.providerId,
    providerName: zai.providerName,
    aliases: zai.aliases,
    isConfigured: zai.isConfigured,
    fetchQuota: zai.fetchQuota
  },
  'zhipuai-coding-plan': {
    providerId: zhipuaiCodingPlan.providerId,
    providerName: zhipuaiCodingPlan.providerName,
    aliases: zhipuaiCodingPlan.aliases,
    isConfigured: zhipuaiCodingPlan.isConfigured,
    fetchQuota: zhipuaiCodingPlan.fetchQuota
  },
  'kimi-for-coding': {
    providerId: kimi.providerId,
    providerName: kimi.providerName,
    aliases: kimi.aliases,
    isConfigured: kimi.isConfigured,
    fetchQuota: kimi.fetchQuota
  },
  openrouter: {
    providerId: openrouter.providerId,
    providerName: openrouter.providerName,
    aliases: openrouter.aliases,
    isConfigured: openrouter.isConfigured,
    fetchQuota: openrouter.fetchQuota
  },
  opendesign: {
    providerId: opendesign.providerId,
    providerName: opendesign.providerName,
    aliases: opendesign.aliases,
    isConfigured: opendesign.isConfigured,
    fetchQuota: opendesign.fetchQuota
  },
  'nano-gpt': {
    providerId: nanogpt.providerId,
    providerName: nanogpt.providerName,
    aliases: nanogpt.aliases,
    isConfigured: nanogpt.isConfigured,
    fetchQuota: nanogpt.fetchQuota
  },
  'github-copilot': {
    providerId: copilot.providerId,
    providerName: copilot.providerName,
    aliases: copilot.aliases,
    isConfigured: copilot.isConfigured,
    fetchQuota: copilot.fetchQuota,
    disabledBy: ['github-copilot']
  },
  'github-copilot-addon': {
    providerId: copilot.providerIdAddon,
    providerName: copilot.providerNameAddon,
    aliases: copilot.aliases,
    isConfigured: copilot.isConfigured,
    fetchQuota: copilot.fetchQuotaAddon,
    // The add-on row reads the same Copilot credential, so the one
    // `github-copilot` entry in disabled_providers governs both rows.
    disabledBy: ['github-copilot']
  },
  'minimax-coding-plan': {
    providerId: minimaxCodingPlan.providerId,
    providerName: minimaxCodingPlan.providerName,
    aliases: minimaxCodingPlan.aliases,
    isConfigured: minimaxCodingPlan.isConfigured,
    fetchQuota: minimaxCodingPlan.fetchQuota
  },
  'minimax-cn-coding-plan': {
    providerId: minimaxCnCodingPlan.providerId,
    providerName: minimaxCnCodingPlan.providerName,
    aliases: minimaxCnCodingPlan.aliases,
    isConfigured: minimaxCnCodingPlan.isConfigured,
    fetchQuota: minimaxCnCodingPlan.fetchQuota
  },
  'ollama-cloud': {
    providerId: ollamaCloud.providerId,
    providerName: ollamaCloud.providerName,
    aliases: ollamaCloud.aliases,
    isConfigured: ollamaCloud.isConfigured,
    fetchQuota: ollamaCloud.fetchQuota
  },
  wafer: {
    providerId: wafer.providerId,
    providerName: wafer.providerName,
    aliases: wafer.aliases,
    isConfigured: wafer.isConfigured,
    fetchQuota: wafer.fetchQuota
  },
  'opencode-go': {
    providerId: opencodeGo.providerId,
    providerName: opencodeGo.providerName,
    aliases: opencodeGo.aliases,
    isConfigured: opencodeGo.isConfigured,
    fetchQuota: opencodeGo.fetchQuota
  },
  neuralwatt: {
    providerId: neuralwatt.providerId,
    providerName: neuralwatt.providerName,
    aliases: neuralwatt.aliases,
    isConfigured: neuralwatt.isConfigured,
    fetchQuota: neuralwatt.fetchQuota
  },
  kilo: {
    providerId: kilo.providerId,
    providerName: kilo.providerName,
    aliases: kilo.aliases,
    isConfigured: kilo.isConfigured,
    fetchQuota: kilo.fetchQuota,
    credentialAliases: ['kilo', 'kilocode', 'kilo-code'],
    fetchQuotaForCredential: fetchWithCredentialRead(kilo.fetchQuota)
  },
  zenmux: {
    providerId: zenmux.providerId,
    providerName: zenmux.providerName,
    aliases: zenmux.aliases,
    isConfigured: zenmux.isConfigured,
    fetchQuota: zenmux.fetchQuota
  },
  xai: {
    providerId: xai.providerId,
    providerName: xai.providerName,
    aliases: xai.aliases,
    isConfigured: xai.isConfigured,
    fetchQuota: xai.fetchQuota
  }
};

const pendingFetches = new Map();

/**
 * The two facts the quota listing takes from the merged OpenCode config,
 * read the way the OpenRouter provider reads its baseURL: `disabled_providers`
 * and the provider instances (`instanceOf`). A config that cannot be read is
 * logged and answers empty facts, so the failure is visible in the server log
 * instead of silently changing which providers list. A layer that failed to
 * parse is logged too: its `disabled_providers` entries cannot be honored.
 */
const readQuotaConfigFacts = () => {
  try {
    const { mergedConfig, layerErrors } = readConfigLayers();
    for (const layerError of layerErrors ?? []) {
      console.warn(`Quota: OpenCode config layer did not parse (${layerError.path}); its disabled_providers entries are not honored.`);
    }
    const disabled = new Set();
    if (Array.isArray(mergedConfig?.disabled_providers)) {
      for (const entry of mergedConfig.disabled_providers) {
        const id = asNonEmptyString(entry);
        if (id) disabled.add(id);
      }
    }
    const instances = new Map();
    for (const sectionKey of ['providers', 'provider']) {
      const section = mergedConfig?.[sectionKey];
      if (!isRecord(section)) continue;
      for (const [id, definition] of Object.entries(section)) {
        if (!isRecord(definition)) continue;
        const base = asNonEmptyString(definition.instanceOf);
        if (base) {
          instances.set(id, { base, name: asNonEmptyString(definition.name) });
        }
      }
    }
    return { disabled, instances };
  } catch (error) {
    console.error('Quota: failed to read the OpenCode config; listing without the disabled filter and instances.', error);
    return { disabled: new Set(), instances: new Map() };
  }
};

/**
 * Whether the listing hides a registry row. The filter keys on the OpenCode
 * provider ids a row answers to (`disabledBy`, by default its own quota id):
 * quota ids and OpenCode provider ids are different namespaces (the Codex
 * row answers to no `openai` entry), so alias matching would hide live rows.
 */
const isProviderDisabled = (facts, provider) => {
  const ids = provider.disabledBy ?? [provider.providerId];
  return ids.some((id) => facts.disabled.has(id));
};

/** The registry provider an instance belongs to, through its base provider id. */
const resolveInstanceProvider = (facts, instanceId) => {
  const instance = facts.instances.get(instanceId);
  if (!instance) return null;
  for (const [id, provider] of Object.entries(registry)) {
    if ((provider.credentialAliases ?? [provider.providerId]).includes(instance.base)) {
      return { providerId: id, provider, instance };
    }
  }
  return null;
};

const isCredentialUsable = (provider, row, authKey = row.integrationID) => {
  try {
    return Boolean(provider.isConfigured({ [authKey]: row.value }));
  } catch {
    return false;
  }
};

/**
 * Providers with a usable credential, plus the configured provider instances
 * that have one. OpenCode's stored credentials are read once and handed to
 * every provider; when OpenCode cannot be asked this throws, so a transient
 * failure does not look like "nothing configured".
 *
 * Providers turned off in OpenCode's config (`disabled_providers`) are left
 * out unless `includeDisabled` is set. Fetching one by name always works:
 * the filter governs the listing, never an explicit ask.
 */
export const listConfiguredQuotaProviders = async ({ includeDisabled = false } = {}) => {
  const auth = await readOpenCodeCredentials();
  const facts = readQuotaConfigFacts();
  const configured = [];

  for (const [id, provider] of Object.entries(registry)) {
    try {
      if (provider.isConfigured(auth)) {
        configured.push(id);
      }
    } catch {
      // Ignore provider-specific config errors in list API.
    }
  }

  const visible = includeDisabled
    ? configured
    : configured.filter((id) => !isProviderDisabled(facts, registry[id]));

  for (const instanceId of facts.instances.keys()) {
    if (!includeDisabled && facts.disabled.has(instanceId)) continue;
    const resolved = resolveInstanceProvider(facts, instanceId);
    if (!resolved?.provider.fetchQuotaForCredential) continue;
    const rows = await listStoredCredentials(instanceId);
    if (rows.some((row) => isCredentialUsable(resolved.provider, row, resolved.instance.base))) {
      visible.push(instanceId);
    }
  }

  return visible;
};

/**
 * Every dispatchable provider and configured provider instance, with the
 * names a caller may resolve it by: its id, its display name, and the
 * credential aliases it answers to, plus whether the merged OpenCode config
 * turns it off. Callers resolve user input (the CLI resolves ids, display
 * names, aliases, and wildcard patterns) against this catalogue; dispatch
 * itself still takes exact provider ids only.
 */
export const listQuotaProviderCatalogue = () => {
  const facts = readQuotaConfigFacts();
  const entries = Object.entries(registry).map(([id, provider]) => ({
    id,
    name: provider.providerName,
    aliases: [...new Set([...(provider.aliases ?? []), ...(provider.credentialAliases ?? [])])],
    disabled: isProviderDisabled(facts, provider)
  }));
  for (const [instanceId, instance] of facts.instances) {
    const resolved = resolveInstanceProvider(facts, instanceId);
    if (!resolved) continue;
    entries.push({
      id: instanceId,
      name: instance.name ?? resolved.provider.providerName,
      aliases: [],
      disabled: facts.disabled.has(instanceId),
      instanceOf: resolved.providerId
    });
  }
  return entries;
};

/**
 * One result per usable stored credential of a provider, each labeled with
 * its credential row. Providers without a per-credential fetch, and providers
 * whose store holds no usable row, answer the single active-credential
 * result, so callers see the same shape either way.
 */
const fetchPerCredential = async (provider, { resultProviderId, resultProviderName, integrationIds, authKey }) => {
  const rows = [];
  for (const integrationID of integrationIds) {
    rows.push(...await listStoredCredentials(integrationID));
  }
  // An instance row is judged under its base provider's integration id: the
  // provider's isConfigured knows 'openai', not 'openai.alternate'.
  const usable = rows.filter((row) => isCredentialUsable(provider, row, authKey));
  if (usable.length === 0) return null;

  const results = [];
  for (const row of usable) {
    const result = await provider.fetchQuotaForCredential(row);
    const labeled = {
      ...result,
      providerId: resultProviderId,
      credentialId: row.id,
      credentialActive: row.active
    };
    if (resultProviderName) labeled.providerName = resultProviderName;
    if (row.label) labeled.credentialLabel = row.label;
    results.push(labeled);
  }
  return results;
};

const unsupportedResult = (providerId) => buildResult({
  providerId,
  providerName: providerId,
  ok: false,
  configured: false,
  error: 'Unsupported provider'
});

/** Per-credential results for a configured instance id, or null when the id is not one. */
const fetchInstanceResults = async (providerId) => {
  const facts = readQuotaConfigFacts();
  const resolved = resolveInstanceProvider(facts, providerId);
  if (!resolved?.provider.fetchQuotaForCredential) return null;
  const results = await fetchPerCredential(resolved.provider, {
    resultProviderId: providerId,
    resultProviderName: resolved.instance.name ?? undefined,
    integrationIds: [providerId],
    authKey: resolved.instance.base
  });
  if (results) return results;
  return [buildResult({
    providerId,
    providerName: resolved.instance.name ?? providerId,
    ok: false,
    configured: false,
    error: 'Not configured'
  })];
};

export const fetchQuotaForProviderInstances = async (providerId) => {
  const provider = registry[providerId];

  if (!provider) {
    return (await fetchInstanceResults(providerId)) ?? [unsupportedResult(providerId)];
  }

  if (!provider.fetchQuotaForCredential) {
    return [await fetchQuotaForProvider(providerId)];
  }

  const results = await fetchPerCredential(provider, {
    resultProviderId: providerId,
    integrationIds: provider.credentialAliases ?? [providerId]
  });
  return results ?? [await fetchQuotaForProvider(providerId)];
};

const fetchQuotaForProviderUncoalesced = async (providerId) => {
  const provider = registry[providerId];

  if (!provider) {
    // An instance id answers with its active credential's result, keeping
    // the one-result shape this function promises.
    const instanceResults = await fetchInstanceResults(providerId);
    if (instanceResults) {
      return instanceResults.find((result) => result.credentialActive) ?? instanceResults[0];
    }
    return unsupportedResult(providerId);
  }

  try {
    return await provider.fetchQuota();
  } catch (error) {
    return buildResult({
      providerId: provider.providerId,
      providerName: provider.providerName,
      aliases: provider.aliases,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};

export const fetchQuotaForProvider = (providerId) => {
  const existing = pendingFetches.get(providerId);
  if (existing) return existing;

  const pending = fetchQuotaForProviderUncoalesced(providerId).finally(() => {
    if (pendingFetches.get(providerId) === pending) pendingFetches.delete(providerId);
  });
  pendingFetches.set(providerId, pending);
  return pending;
};

export const fetchClaudeQuota = claude.fetchQuota;
export const fetchOpenaiQuota = openai.fetchQuota;
export const fetchGoogleQuota = google.fetchGoogleQuota;
export const fetchAntigravityQuota = antigravity.fetchQuota;
export const fetchCodexQuota = codex.fetchQuota;
export const fetchCursorQuota = cursor.fetchQuota;
export const fetchDeepinfraQuota = deepinfra.fetchQuota;
export const fetchDeepseekQuota = deepseek.fetchQuota;
export const fetchHyperQuota = hyper.fetchQuota;
export const fetchCopilotQuota = copilot.fetchQuota;
export const fetchCopilotAddonQuota = copilot.fetchQuotaAddon;
export const fetchKimiQuota = kimi.fetchQuota;
export const fetchOpenRouterQuota = openrouter.fetchQuota;
export const fetchZaiQuota = zai.fetchQuota;
const fetchZhipuaiCodingPlanQuota = zhipuaiCodingPlan.fetchQuota;
export const fetchNanoGptQuota = nanogpt.fetchQuota;
export const fetchMinimaxCodingPlanQuota = minimaxCodingPlan.fetchQuota;
export const fetchMinimaxCnCodingPlanQuota = minimaxCnCodingPlan.fetchQuota;
export const fetchOllamaCloudQuota = ollamaCloud.fetchQuota;
export const fetchWaferQuota = wafer.fetchQuota;
export const fetchZhipuaiQuota = zhipuaiCodingPlan.fetchQuota;
