/**
 * Notes and suggestions built from the recorded model choices. Deterministic:
 * the same events always give the same notes, and no model is asked.
 */

/** A note needs at least this many matching choices. */
export const MIN_NOTE_COUNT = 2;
/** A suggestion reads the surface's most recent choices only, so it follows today's habit. */
export const SUGGESTION_WINDOW = 20;
/** And needs this many matching choices among them, ... */
export const MIN_SUGGESTION_COUNT = 5;
/** ... making up at least this share of the window. */
export const MIN_SUGGESTION_SHARE = 0.7;
/** A detail (input size, what it replaced) is named when it covers this share of the note's choices. */
const DOMINANT_SHARE = 0.7;
const MAX_NOTES = 20;

const SURFACE_PURPOSE = {
  'goal-writer': 'goal specs',
  composer: 'chat messages',
};

const POOL_PROVIDER = 'opencode-route';

const modelLabel = (ref) => {
  const separator = ref.indexOf('/');
  const provider = ref.slice(0, separator);
  const id = ref.slice(separator + 1);
  return provider === POOL_PROVIDER ? `pool ${id}` : id;
};

const selectionLabel = ({ model, variant }) => `${variant ? `${variant} effort` : 'default effort'} on ${modelLabel(model)}`;

const selectionKey = ({ model, variant }) => `${model}|${variant ?? ''}`;

/** The value that covers at least `DOMINANT_SHARE` of `values`, or null. */
const dominant = (values) => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const [value, count] of counts) {
    if (count / values.length >= DOMINANT_SHARE) return value;
  }
  return null;
};

/** Choices of one surface grouped by what was chosen, largest group first; ties go to the most recent. */
const groupByChoice = (events) => {
  const groups = new Map();
  events.forEach((event, index) => {
    const key = selectionKey(event.chosen);
    const group = groups.get(key) ?? { chosen: event.chosen, events: [], lastIndex: 0 };
    group.events.push(event);
    group.lastIndex = index;
    groups.set(key, group);
  });
  return [...groups.values()].sort((a, b) => (b.events.length - a.events.length) || (b.lastIndex - a.lastIndex));
};

const bySurface = (events) => {
  const surfaces = new Map();
  for (const event of events) {
    const list = surfaces.get(event.surface) ?? [];
    list.push(event);
    surfaces.set(event.surface, list);
  }
  return surfaces;
};

/**
 * One note per surface and choice made at least twice, such as "picks low
 * effort on claude-opus-4 for goal specs (7 of 9 times)". Events are oldest
 * first, as the store keeps them.
 */
export const buildModelChoiceNotes = (events) => {
  const notes = [];
  for (const [surface, surfaceEvents] of bySurface(events)) {
    const total = surfaceEvents.length;
    for (const group of groupByChoice(surfaceEvents)) {
      const count = group.events.length;
      if (count < MIN_NOTE_COUNT) continue;
      const inputSize = dominant(group.events.map((event) => event.inputSize).filter((size) => size !== 'unknown'));
      const replacedKey = dominant(group.events.map((event) => (event.replaced ? selectionKey(event.replaced) : 'none')));
      const replaced = replacedKey && replacedKey !== 'none'
        ? group.events.find((event) => event.replaced && selectionKey(event.replaced) === replacedKey).replaced
        : null;
      let text = `picks ${selectionLabel(group.chosen)} for ${SURFACE_PURPOSE[surface]} (${count} of ${total} times)`;
      if (replaced) text += `, usually over ${selectionLabel(replaced)}`;
      if (inputSize && inputSize !== 'empty') text += `, mostly for ${inputSize} inputs`;
      notes.push({
        surface,
        model: group.chosen.model,
        variant: group.chosen.variant,
        count,
        total,
        replaced,
        inputSize,
        text,
      });
    }
  }
  return notes.sort((a, b) => b.count - a.count).slice(0, MAX_NOTES);
};

export const goalWriterSuggestionId = ({ model, variant }) => `goal-writer:${model}:${variant ?? 'default'}`;

/**
 * Settings changes the notes support. Only the goal writer's default model
 * and effort are suggested: it is one setting with one meaning, the model the
 * goal window starts on. A suggestion needs a clear habit in the surface's
 * recent choices, must differ from the current setting, and is never offered
 * again once the user approved or declined it.
 */
export const buildModelChoiceSuggestions = ({ events, decisions, settings }) => {
  const decided = new Set(decisions.map((entry) => entry.id));
  const recent = events.filter((event) => event.surface === 'goal-writer').slice(-SUGGESTION_WINDOW);
  const [top] = groupByChoice(recent);
  if (!top) return [];
  const count = top.events.length;
  if (count < MIN_SUGGESTION_COUNT || count / recent.length < MIN_SUGGESTION_SHARE) return [];

  const currentModel = typeof settings.sessionGoalWriterModel === 'string' ? settings.sessionGoalWriterModel.trim() : '';
  const currentVariant = typeof settings.sessionGoalWriterVariant === 'string' ? settings.sessionGoalWriterVariant.trim() : '';
  if (currentModel === top.chosen.model && currentVariant === (top.chosen.variant ?? '')) return [];

  const id = goalWriterSuggestionId(top.chosen);
  if (decided.has(id)) return [];
  return [{
    id,
    surface: 'goal-writer',
    model: top.chosen.model,
    variant: top.chosen.variant,
    count,
    total: recent.length,
    settings: {
      sessionGoalWriterModel: top.chosen.model,
      sessionGoalWriterVariant: top.chosen.variant ?? '',
    },
  }];
};
