import express from 'express';
import { openRouteDb, resolveOpenCodeDbPath } from './model-route-stats.js';
import {
  answerQuestion,
  choiceQuestions,
  fromChoices,
  groundChoices,
  interpret,
  keywords,
  toOverrides,
} from './route-interpreter.js';
import { learnedChoices } from './route-learning.js';
import { LOCAL_MODEL, assertVerifiable, createLocalAnswerer, downloadModel, modelPath, modelStatus } from './route-local-model.js';
import { createOverrideStore } from './route-overrides-store.js';
import { createSettingsStore } from './route-settings.js';
import { cooldownHistory, estimateWait } from './route-wait.js';

const MIN_CHOICE_CONFIDENCE = 0.6;

const httpError = (status, message) => Object.assign(new Error(message), { status });

const parseText = (value) => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 500) {
    throw httpError(400, 'text must be 1 to 500 characters');
  }
  return value.trim();
};

const parseContext = (value) => {
  if (!Array.isArray(value?.providers) || !Array.isArray(value?.models)) {
    throw httpError(400, 'context needs providers and models');
  }
  return {
    providers: value.providers.filter((id) => typeof id === 'string').slice(0, 200),
    models: value.models
      .filter((model) => typeof model?.id === 'string' && typeof model?.providerID === 'string')
      .slice(0, 5000),
  };
};

const queryValue = (value) => (typeof value === 'string' ? value.trim() : '');

const schemaFor = (questions) => ({
  type: 'object',
  properties: Object.fromEntries(
    Object.entries(questions).map(([key, question]) => [key, { type: 'string', enum: Object.keys(question.criteria) }]),
  ),
  required: Object.keys(questions),
});

const promptFor = (text, questions) =>
  [
    `Sentence: ${text}`,
    ...Object.entries(questions).map(
      ([key, question]) =>
        `${key}: ${question.instructions} Options: ${Object.entries(question.criteria)
          .map(([option, meaning]) => `${option} = ${meaning}`)
          .join('; ')}`,
    ),
  ].join('\n');

const choicesOf = (answers) => Object.fromEntries(Object.entries(answers).map(([key, answer]) => [key, answer?.choice]));

const localStage = (answerer, file, model) => async (text, context) => {
  if (!modelStatus(file, model).installed) return undefined;
  const questions = choiceQuestions(context);
  const answers = await answerer.answer({ prompt: promptFor(text, questions), schema: schemaFor(questions) });
  return fromChoices(groundChoices(answers, text, context), { text, context, confidence: 'tentative' });
};

const externalStage = ({ jev, classifier }) => async (text, context) => {
  const endpoint = await classifier();
  if (!endpoint) return undefined;
  const questions = choiceQuestions(context);
  const { answers } = await jev.ask({ state: { request: text, providers: context.providers }, questions }, endpoint);
  if ((answers.action?.confidence ?? 0) < MIN_CHOICE_CONFIDENCE) return undefined;
  return fromChoices(choicesOf(answers), { text, context, confidence: 'tentative' });
};

const createRouteRules = ({
  store = createOverrideStore(),
  settings = createSettingsStore(),
  jev,
  classifier,
  answerer = createLocalAnswerer(),
  modelFile = modelPath(),
  model = LOCAL_MODEL,
  fetchImpl = fetch,
  dbPath = resolveOpenCodeDbPath(),
  now = () => Date.now(),
}) => {
  const download = { active: false, received: 0, error: null };

  const localStatus = () => {
    const status = modelStatus(modelFile, model);
    return {
      ...status,
      downloading: download.active,
      downloadedBytes: download.active ? download.received : status.downloadedBytes,
      error: download.error,
    };
  };

  // A model with no pinned checksum is refused here, as an HTTP error, before any state changes.
  const startDownload = () => {
    if (download.active || modelStatus(modelFile, model).installed) return localStatus();
    assertVerifiable(model);
    Object.assign(download, { active: true, received: 0, error: null });
    downloadModel({ file: modelFile, model, fetchImpl, onProgress: (received) => (download.received = received) })
      .catch((error) => (download.error = error.message))
      .finally(() => (download.active = false));
    return localStatus();
  };

  const commit = (decision) => {
    store.add(
      toOverrides(decision.drafts, {
        source: 'interpreter',
        now: now(),
        summary: decision.summary,
        origin: decision.origin,
      }),
    );
    return { status: 'applied', stage: decision.stage, confidence: decision.confidence, summary: decision.summary, rules: store.list() };
  };

  const interpretText = async (text, context) => {
    const { stages: toggles, learnAfter } = settings.read();
    const learned = learnedChoices(store.readFeedback(), { learnAfter });
    const result = await interpret({
      text,
      context: { ...context, now: now() },
      learned,
      toggles,
      stages: { local: localStage(answerer, modelFile, model), external: externalStage({ jev, classifier }) },
    });
    if (result.status === 'decided') return commit(result);
    if (result.status === 'clarify') {
      return { status: 'clarify', key: result.key, question: result.question, options: result.options.map((item) => item.label) };
    }
    return { status: 'unknown', reason: result.reason };
  };

  const answerClarifying = (text, context, key, label) => {
    const question = keywords(text, { ...context, now: now() }, {});
    if (question.status !== 'clarify' || question.key !== key) {
      throw httpError(400, 'That question no longer applies to this sentence');
    }
    const decision = answerQuestion(question, label);
    if (!decision) throw httpError(400, 'That is not one of the options');
    const applied = commit(decision);
    store.recordFeedback({ text, key, option: label, accepted: 'corrected' });
    return applied;
  };

  const undo = (id) => {
    const rules = store.list();
    const target = rules.find((rule) => rule.id === id);
    if (!target) return null;
    const group = rules.filter(
      (rule) => rule.createdAt === target.createdAt && rule.summary === target.summary && rule.text === target.text,
    );
    for (const rule of group) store.remove(rule.id);
    if (target.origin) {
      store.recordFeedback({ text: target.text, key: target.origin.key, option: target.origin.option, accepted: false });
    }
    return store.list();
  };

  const wait = async ({ providerID, modelID }) => {
    const { waitPercentile, waitMinSamples } = settings.read();
    let db;
    try {
      db = await openRouteDb(dbPath);
      const rows = cooldownHistory(db, { providerID, modelID, now: now() });
      return estimateWait(rows, { now: now(), percentile: waitPercentile, minSamples: waitMinSamples });
    } catch (error) {
      if (error.code === 'no-database' || error.code === 'no-tables') {
        return { ...estimateWait([], { now: now() }), reason: error.code };
      }
      throw error;
    } finally {
      db?.close();
    }
  };

  return {
    rules: () => store.list(),
    settings: () => settings.read(),
    saveSettings: (input) => settings.write(input && typeof input === 'object' ? input : {}),
    interpret: interpretText,
    answer: answerClarifying,
    undo,
    wait,
    localStatus,
    startDownload,
  };
};

export const registerRouteRulesRoutes = (app, { routingRuntime, jev, ...options }) => {
  const service = createRouteRules({
    jev,
    classifier: () => routingRuntime.classifierEndpoint(),
    ...options,
  });

  const route = (handler) => async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (error) {
      res.status(error.status ?? 500).json({ error: error.message });
    }
  };

  app.get(
    '/api/model-routes/rules',
    route(() => ({ rules: service.rules() })),
  );

  app.post(
    '/api/model-routes/interpret',
    express.json({ limit: '1mb' }),
    route((req) => service.interpret(parseText(req.body?.text), parseContext(req.body?.context))),
  );

  app.post(
    '/api/model-routes/interpret/answer',
    express.json({ limit: '1mb' }),
    route((req) =>
      service.answer(
        parseText(req.body?.text),
        parseContext(req.body?.context),
        queryValue(req.body?.key),
        queryValue(req.body?.label),
      ),
    ),
  );

  app.delete(
    '/api/model-routes/rules/:id',
    route((req) => {
      const rules = service.undo(req.params.id);
      if (!rules) throw httpError(404, 'No such rule');
      return { rules };
    }),
  );

  app.get('/api/model-routes/settings', route(() => service.settings()));

  app.put(
    '/api/model-routes/settings',
    express.json({ limit: '4kb' }),
    route((req) => service.saveSettings(req.body)),
  );

  app.get(
    '/api/model-routes/wait',
    route((req) => {
      const providerID = queryValue(req.query.provider);
      const modelID = queryValue(req.query.model);
      if (!providerID || !modelID) throw httpError(400, 'provider and model are required');
      return service.wait({ providerID, modelID });
    }),
  );

  app.get('/api/model-routes/local', route(() => service.localStatus()));

  app.post('/api/model-routes/local/download', route(() => service.startDownload()));
};
