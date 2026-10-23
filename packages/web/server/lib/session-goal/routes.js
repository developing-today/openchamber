import { z } from 'zod';

import { deleteObjective, readObjective, writeObjective } from './objectives.js';
import {
  GOAL_SPEC_DEFAULT_PROMPT,
  goalSpecRules,
  readGoalWriterSettings,
  rewriteGoalWriterPrompt,
  writeGoalSpec,
} from './spec-writer.js';

// Optional text fields: anything but a string is left out, not refused.
const optionalText = z.string().optional().catch(undefined);
const GoalSpecBodySchema = z.object({
  request: optionalText,
  conversation: optionalText,
  openItems: optionalText,
  directory: optionalText,
  providerID: optionalText,
  modelID: optionalText,
  // A model and effort picked for this one spec; they win over Settings.
  writerProviderID: optionalText,
  writerModelID: optionalText,
  writerVariant: optionalText,
  ignoreLimit: z.boolean().optional().catch(undefined),
}).catch({});
const GoalPromptRewriteBodySchema = z.object({
  prompt: optionalText,
  instruction: optionalText,
  directory: optionalText,
  providerID: optionalText,
  modelID: optionalText,
}).catch({});
const ErrorCodeSchema = z.object({ code: z.string() });

/**
 * Answers with what `generate` returns. A client that goes away aborts the
 * model call, so nobody pays for a reply nobody reads; a failure keeps the
 * status and code it was thrown with.
 */
const respondWithGeneration = async (res, generate, failureMessage) => {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  try {
    res.json(await generate(controller.signal));
  } catch (error) {
    if (controller.signal.aborted) return;
    const statusCode = Number(error?.statusCode) || 500;
    if (statusCode >= 500) {
      console.error(`${failureMessage}:`, error);
    }
    const payload = { error: error?.message || failureMessage };
    const coded = ErrorCodeSchema.safeParse(error);
    if (coded.success) payload.code = coded.data.code;
    res.status(statusCode).json(payload);
  }
};

// OpenChamber-owned routes for file-backed goal objectives, keyed by session
// id (one goal per session; a new goal overwrites the old file). The UI
// writes the objective file before stamping the goal metadata (which only
// carries an `objectiveFile: true` flag), reads it back for display, and
// deletes it when the goal is removed.
export function registerSessionGoalRoutes(app, {
  writeSpec = writeGoalSpec,
  rewritePrompt = rewriteGoalWriterPrompt,
  readWriterSettings = readGoalWriterSettings,
} = {}) {
  app.put('/api/goals/objective/:sessionId', async (req, res) => {
    try {
      const { content } = req.body || {};
      const saved = await writeObjective(req.params.sessionId, content);
      // The saved length lets a client notice a server that cut the text.
      res.json({ ok: true, length: saved.content.length });
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('Failed to write goal objective:', error);
      }
      res.status(statusCode).json({ error: error?.message || 'Failed to write goal objective' });
    }
  });

  app.get('/api/goals/objective/:sessionId', async (req, res) => {
    const content = await readObjective(req.params.sessionId);
    if (content === null) {
      res.status(404).json({ error: 'objective not found' });
      return;
    }
    res.json({ content });
  });

  app.delete('/api/goals/objective/:sessionId', async (req, res) => {
    await deleteObjective(req.params.sessionId);
    res.json({ ok: true });
  });

  // The goal writer: the UI sends the user's message (plus optional context)
  // and gets back a goal spec to use as the objective.
  app.post('/api/goals/spec', (req, res) => {
    const body = GoalSpecBodySchema.parse(req.body);
    return respondWithGeneration(res, (signal) => writeSpec({ ...body, signal }), 'Failed to write goal spec');
  });

  // Settings shows the built-in prompt and the rules every prompt gets, with
  // the length rule for the goal length limit in Settings, as the writer gets
  // it; the server owns both texts, so the UI never carries a copy.
  app.get('/api/goals/spec/prompt', (_req, res) => {
    res.json({ prompt: GOAL_SPEC_DEFAULT_PROMPT, rules: goalSpecRules(readWriterSettings().charLimit) });
  });

  // "Describe a change": the goal writer's model rewrites the prompt shown in
  // Settings. Like the writer itself, it reaches only models configured in
  // OpenCode, so enterprise mode leaves both routes open.
  app.post('/api/goals/spec/prompt/rewrite', (req, res) => {
    const body = GoalPromptRewriteBodySchema.parse(req.body);
    return respondWithGeneration(res, (signal) => rewritePrompt({ ...body, signal }), 'Failed to rewrite the goal writer prompt');
  });
}
