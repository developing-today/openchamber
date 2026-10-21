import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSessionGoalRoutes } from './routes.js';
import { GOAL_SPEC_DEFAULT_PROMPT, GOAL_SPEC_RULES, rewriteGoalWriterPrompt } from './spec-writer.js';

const writeGoalSpecMock = vi.fn();
const rewritePromptMock = vi.fn();

const createApp = (deps = { writeSpec: writeGoalSpecMock, rewritePrompt: rewritePromptMock }) => {
  const app = express();
  app.use(express.json());
  registerSessionGoalRoutes(app, deps);
  return app;
};

describe('POST /api/goals/spec', () => {
  beforeEach(() => {
    writeGoalSpecMock.mockReset();
  });

  it('writes a spec from the request and passes only string fields on', async () => {
    writeGoalSpecMock.mockResolvedValue({ spec: '## Objective\nShip it.', providerID: 'openai', modelID: 'gpt-5.5' });

    const response = await request(createApp())
      .post('/api/goals/spec')
      .send({ request: 'Ship it', conversation: 'context', openItems: 42, directory: '/repo', providerID: 'openai', modelID: 'gpt-5.5' })
      .expect(200);

    expect(response.body).toEqual({ spec: '## Objective\nShip it.', providerID: 'openai', modelID: 'gpt-5.5' });
    expect(writeGoalSpecMock).toHaveBeenCalledWith(expect.objectContaining({
      request: 'Ship it',
      conversation: 'context',
      openItems: undefined,
      directory: '/repo',
      providerID: 'openai',
      modelID: 'gpt-5.5',
      signal: expect.any(AbortSignal),
    }));
  });

  it('passes a model, effort and limit choice made for this spec', async () => {
    writeGoalSpecMock.mockResolvedValue({ spec: 'spec', providerID: 'google', modelID: 'gemini', variant: 'low' });
    await request(createApp())
      .post('/api/goals/spec')
      .send({ request: 'Ship it', writerProviderID: 'google', writerModelID: 'gemini', writerVariant: 'low', ignoreLimit: true })
      .expect(200);
    expect(writeGoalSpecMock).toHaveBeenCalledWith(expect.objectContaining({
      writerProviderID: 'google', writerModelID: 'gemini', writerVariant: 'low', ignoreLimit: true,
    }));
  });

  it('answers with the writer error status and code', async () => {
    writeGoalSpecMock.mockRejectedValue(Object.assign(new Error('a request is required to write a goal spec'), {
      statusCode: 400,
      code: 'goal-spec-request-required',
    }));

    const response = await request(createApp())
      .post('/api/goals/spec')
      .send({ request: 7 })
      .expect(400);

    expect(writeGoalSpecMock).toHaveBeenCalledWith(expect.objectContaining({ request: undefined }));
    expect(response.body).toEqual({ error: 'a request is required to write a goal spec', code: 'goal-spec-request-required' });
  });

  it('reports an unexpected failure as 500', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeGoalSpecMock.mockRejectedValue(new Error('boom'));

    const response = await request(createApp())
      .post('/api/goals/spec')
      .send({ request: 'Ship it' })
      .expect(500);

    expect(response.body).toEqual({ error: 'boom' });
    consoleError.mockRestore();
  });
});

describe('GET /api/goals/spec/prompt', () => {
  it('serves the built-in prompt and the rules every prompt gets', async () => {
    const response = await request(createApp()).get('/api/goals/spec/prompt').expect(200);
    expect(response.body).toEqual({ prompt: GOAL_SPEC_DEFAULT_PROMPT, rules: GOAL_SPEC_RULES });
    expect(response.body.prompt.length).toBeGreaterThan(100);
  });
});

describe('POST /api/goals/spec/prompt/rewrite', () => {
  beforeEach(() => {
    rewritePromptMock.mockReset();
  });

  it('returns the prompt the model rewrote and passes only string fields on', async () => {
    rewritePromptMock.mockResolvedValue({ prompt: 'Write short specs.', providerID: 'anthropic', modelID: 'claude' });

    const response = await request(createApp())
      .post('/api/goals/spec/prompt/rewrite')
      .send({ prompt: 'Write specs.', instruction: 'shorter', directory: 9, providerID: 'openai', modelID: 'gpt-5.5' })
      .expect(200);

    expect(response.body).toEqual({ prompt: 'Write short specs.', providerID: 'anthropic', modelID: 'claude' });
    expect(rewritePromptMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Write specs.',
      instruction: 'shorter',
      directory: undefined,
      providerID: 'openai',
      modelID: 'gpt-5.5',
      signal: expect.any(AbortSignal),
    }));
  });

  it('refuses an empty instruction with 400 before any model is called', async () => {
    const generate = vi.fn();
    const app = createApp({
      writeSpec: writeGoalSpecMock,
      rewritePrompt: (input) => rewriteGoalWriterPrompt({ ...input, settings: {}, generate }),
    });

    const response = await request(app)
      .post('/api/goals/spec/prompt/rewrite')
      .send({ prompt: 'Write specs.', instruction: '   ' })
      .expect(400);

    expect(response.body).toEqual({ error: 'describe the change to make to the goal writer prompt', code: 'goal-prompt-change-required' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('answers the rewrite failure with its status and code', async () => {
    rewritePromptMock.mockRejectedValue(Object.assign(new Error('the model returned no prompt'), {
      statusCode: 502,
      code: 'goal-prompt-empty',
    }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(createApp())
      .post('/api/goals/spec/prompt/rewrite')
      .send({ instruction: 'shorter' })
      .expect(502);

    expect(response.body).toEqual({ error: 'the model returned no prompt', code: 'goal-prompt-empty' });
    consoleError.mockRestore();
  });
});

// Both routes reach only models configured in OpenCode, through the small-model
// generate path, which enterprise mode leaves open (enterprise-boundary skill:
// the small model on the user's own provider sits inside the boundary). The
// rewrite answers to the mode exactly as the writer does; a gate added to one
// of them alone fails here.
describe('goal writer routes in enterprise mode', () => {
  const previous = process.env.OPENCHAMBER_ENTERPRISE_MODE;

  beforeEach(() => {
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    writeGoalSpecMock.mockReset();
    rewritePromptMock.mockReset();
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    else process.env.OPENCHAMBER_ENTERPRISE_MODE = previous;
  });

  it('answers the prompt rewrite the same way as the spec writer', async () => {
    writeGoalSpecMock.mockResolvedValue({ spec: '## Objective\nShip it.', providerID: 'openai', modelID: 'gpt-5.5' });
    rewritePromptMock.mockResolvedValue({ prompt: 'Write short specs.', providerID: 'openai', modelID: 'gpt-5.5' });
    const app = createApp();

    const writer = await request(app).post('/api/goals/spec').send({ request: 'Ship it' });
    const rewrite = await request(app).post('/api/goals/spec/prompt/rewrite').send({ instruction: 'shorter' });

    expect(writer.status).toBe(200);
    expect(rewrite.status).toBe(writer.status);
    expect(rewritePromptMock).toHaveBeenCalledTimes(1);
    expect(writeGoalSpecMock).toHaveBeenCalledTimes(1);
  });
});
