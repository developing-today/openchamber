import { z } from 'zod';

import { deleteObjective, readObjective, writeObjective } from './objectives.js';
import { writeGoalSpec } from './spec-writer.js';

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
const ErrorCodeSchema = z.object({ code: z.string() });

// OpenChamber-owned routes for file-backed goal objectives, keyed by session
// id (one goal per session; a new goal overwrites the old file). The UI
// writes the objective file before stamping the goal metadata (which only
// carries an `objectiveFile: true` flag), reads it back for display, and
// deletes it when the goal is removed.
export function registerSessionGoalRoutes(app, { writeSpec = writeGoalSpec } = {}) {
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
  app.post('/api/goals/spec', async (req, res) => {
    const body = GoalSpecBodySchema.parse(req.body);
    // Stop paying for a spec nobody will read once the client goes away.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const result = await writeSpec({ ...body, signal: controller.signal });
      res.json(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('Failed to write goal spec:', error);
      }
      const payload = { error: error?.message || 'Failed to write goal spec' };
      const coded = ErrorCodeSchema.safeParse(error);
      if (coded.success) payload.code = coded.data.code;
      res.status(statusCode).json(payload);
    }
  });
}
