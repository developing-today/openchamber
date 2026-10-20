import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerSessionGoalRoutes } from './routes.js';

const writeGoalSpecMock = vi.fn();

const createApp = () => {
  const app = express();
  app.use(express.json());
  registerSessionGoalRoutes(app, { writeSpec: writeGoalSpecMock });
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
