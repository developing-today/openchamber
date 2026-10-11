/**
 * Beginner presets that build a model pool from the OpenCode catalog.
 * Each returns route targets (`providerID/modelID` strings) for a new
 * `opencode-route/*` entry:
 *
 * - cheapest: the lowest per-token cost first.
 * - fastest: the smallest context windows first, a size proxy for speed since
 *   the catalog carries no latency numbers.
 * - sturdiest: the model id listed by the most providers, cheapest first, so
 *   the pool survives any single provider going down.
 */
import type { Model, Provider } from '@/lib/opencode/model';

export type PresetId = 'cheap' | 'fast' | 'sturdy';

interface CatalogModel {
  providerID: string;
  modelID: string;
  model: Model;
}

export const PRESET_ROUTE_IDS: Record<PresetId, string> = {
  cheap: 'cheap-pool',
  fast: 'fast-pool',
  sturdy: 'sturdy-pool',
};

const baseCost = (model: Model): number => {
  const entry = model.cost.find((item) => !item.tier) ?? model.cost[0];
  if (!entry) return Number.POSITIVE_INFINITY;
  return entry.input + entry.output;
};

// Pools answer chat prompts, so only models that take text in and out are eligible;
// image and video models would fail every send they receive.
const enabledModels = (providers: Array<Provider & { models: Model[] }>): CatalogModel[] =>
  providers.flatMap((provider) =>
    (provider.models ?? [])
      .filter(
        (model) =>
          model.enabled !== false &&
          model.status !== 'deprecated' &&
          model.capabilities.input.includes('text') &&
          model.capabilities.output.includes('text'),
      )
      .map((model) => ({ providerID: provider.id, modelID: model.id, model })),
  );

/** Cheapest per-token cost first, one entry per provider/model, capped. */
export const cheapestTargets = (
  providers: Array<Provider & { models: Model[] }>,
  count = 4,
): string[] =>
  [...enabledModels(providers)]
    .sort((a, b) => baseCost(a.model) - baseCost(b.model) || a.providerID.localeCompare(b.providerID))
    .slice(0, count)
    .map(({ providerID, modelID }: CatalogModel) => `${providerID}/${modelID}`);

/** Smallest context windows first: a size proxy for speed. */
export const fastestTargets = (
  providers: Array<Provider & { models: Model[] }>,
  count = 4,
): string[] =>
  [...enabledModels(providers)]
    .filter(({ model }: CatalogModel) => model.limit.context > 0)
    .sort((a: CatalogModel, b: CatalogModel) => a.model.limit.context - b.model.limit.context)
    .slice(0, count)
    .map(({ providerID, modelID }: CatalogModel) => `${providerID}/${modelID}`);

/**
 * The model id offered by the most providers, cheapest first. Returns [] when
 * no model id appears under more than one provider.
 */
export const sturdiestTargets = (providers: Array<Provider & { models: Model[] }>): string[] => {
  const byModel = new Map<string, CatalogModel[]>();
  for (const entry of enabledModels(providers)) {
    const list = byModel.get(entry.modelID) ?? [];
    list.push(entry);
    byModel.set(entry.modelID, list);
  }
  let best: CatalogModel[] | null = null;
  let bestProviders = 1;
  for (const list of byModel.values()) {
    const distinct = new Set(list.map((entry) => entry.providerID)).size;
    if (distinct > bestProviders) {
      bestProviders = distinct;
      best = list;
    }
  }
  if (!best) return [];
  return [...best]
    .sort((a: CatalogModel, b: CatalogModel) => baseCost(a.model) - baseCost(b.model))
    .map(({ providerID, modelID }: CatalogModel) => `${providerID}/${modelID}`);
};

export const presetTargets = (
  preset: PresetId,
  providers: Array<Provider & { models: Model[] }>,
): string[] => {
  if (preset === 'cheap') return cheapestTargets(providers);
  if (preset === 'fast') return fastestTargets(providers);
  return sturdiestTargets(providers);
};
