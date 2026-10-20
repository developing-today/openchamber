import fs from 'fs';
import os from 'os';
import path from 'path';

import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildGoalIntroText } from './create.js';
import { createGoalSpecJobRuntime, registerGoalSpecJobRoutes } from './spec-jobs.js';

const SESSION = 'ses_goal_job_1';
const DIRECTORY = '/repo';
const SPEC = '## Objective\nShip dark mode';

const tempDirs = [];
const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-goal-spec-jobs-'));
  tempDirs.push(dir);
  return dir;
};

const runtimes = [];

afterEach(async () => {
  // Writes chained before a test ended land before its directory goes.
  for (const runtime of runtimes.splice(0)) {
    runtime.stop();
    await runtime.flush();
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake OpenCode that records every session call in order. */
const createOpenCode = () => {
  const state = { calls: [], failPath: null };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (state.failPath && state.failPath.test(pathname)) {
      return new Response('upstream refused', { status: 500 });
    }
    state.calls.push({ route: pathname.split('/').at(-1), body: JSON.parse(init.body) });
    return Response.json({ data: { id: `msg_${state.calls.length}` } });
  });
  return { state, fetchImpl };
};

/** A writer whose answers the test hands out one call at a time. */
const createWriter = () => {
  const calls = [];
  const writeSpec = vi.fn((input) => new Promise((resolve, reject) => {
    calls.push({ input, resolve, reject });
  }));
  return { writeSpec, calls };
};

const job = (overrides = {}) => ({
  sessionId: SESSION,
  directory: DIRECTORY,
  trigger: 'armed',
  review: true,
  sendMode: 'with-message',
  tokenBudget: null,
  message: { content: 'add dark mode', text: 'add dark mode', attachments: [], context: [] },
  sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build', variant: 'high' },
  writerInput: { conversation: 'User: earlier work', openItems: '' },
  ...overrides,
});

const createRuntime = ({ dataDir = makeDataDir(), openCode = createOpenCode(), writer = createWriter(), settings = {}, claimTtlMs } = {}) => {
  const broadcasts = [];
  const goals = [];
  const promptSent = [];
  let eventHandler = () => {};
  const options = {
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus() { return () => {}; },
    },
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    broadcastGlobalUiEvent: (event) => broadcasts.push(event),
    persistSessionGoal: vi.fn(),
    onPromptSent: (sessionId) => promptSent.push(sessionId),
    dataDir,
    writeSpec: writer.writeSpec,
    readWriterSettings: () => settings,
    createGoal: async (input) => {
      goals.push(input);
      return { goal: { id: 'goal-1' }, spec: null };
    },
    fetchImpl: openCode.fetchImpl,
  };
  if (claimTtlMs) options.claimTtlMs = claimTtlMs;
  const runtime = createGoalSpecJobRuntime(options);
  runtimes.push(runtime);
  return {
    runtime,
    openCode,
    writer,
    broadcasts,
    goals,
    promptSent,
    dataDir,
    emit: (payload) => eventHandler({ translated: () => [payload] }),
    statuses: () => broadcasts.map((event) => event.properties.job?.status ?? null),
  };
};

const writeAnswer = (writer, index = writer.calls.length - 1) => {
  writer.calls[index].resolve({ spec: SPEC, providerID: 'openai', modelID: 'gpt-writer' });
};

describe('goal writer jobs', () => {
  it('writes the spec and waits for the user while review is on', async () => {
    const { runtime, writer, broadcasts, openCode } = createRuntime({ settings: { model: 'openai/gpt-writer', variant: 'low' } });

    const created = await runtime.create(job());
    expect(created.job).toMatchObject({ status: 'writing', attempt: 1, sending: false, composerOnly: false });
    expect(created.job.writer).toEqual({ source: 'settings', providerID: 'openai', modelID: 'gpt-writer', variant: 'low' });
    expect(writer.writeSpec).toHaveBeenCalledWith(expect.objectContaining({
      request: 'add dark mode',
      conversation: 'User: earlier work',
      directory: DIRECTORY,
      providerID: 'anthropic',
      modelID: 'claude',
      signal: expect.any(AbortSignal),
    }));

    writeAnswer(writer);
    await runtime.whenIdle();

    const [ready] = runtime.snapshot().jobs;
    expect(ready).toMatchObject({ status: 'ready', spec: SPEC, error: null });
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'openchamber:goal-spec-job.updated',
      properties: { sessionId: SESSION, job: { status: 'ready' } },
    });
    expect(broadcasts.map((event) => event.properties.revision)).toEqual([1, 2]);
    expect(openCode.state.calls).toEqual([]);
  });

  it('names the session model as the writer, and the small model for a session on Auto', async () => {
    const { runtime } = createRuntime();
    const onSession = await runtime.create(job());
    expect(onSession.job.writer).toEqual({ source: 'session', providerID: 'anthropic', modelID: 'claude', variant: null });

    const onAuto = await runtime.create(job({
      sessionId: 'ses_goal_job_auto',
      sendConfig: { providerID: 'openchamber', modelID: 'auto' },
    }));
    expect(onAuto.job.writer).toEqual({ source: 'small-model', providerID: null, modelID: null, variant: null });
  });

  it('records the reason when the writer fails, and Redo writes again', async () => {
    const { runtime, writer } = createRuntime();
    await runtime.create(job());
    writer.calls[0].reject(new Error('No small model available'));
    await runtime.whenIdle();
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'failed', error: 'No small model available' });

    const redone = await runtime.redo(runtime.snapshot().jobs[0].id);
    expect(redone.job).toMatchObject({ status: 'writing', attempt: 2, error: null });
    writeAnswer(writer, 1);
    await runtime.whenIdle();
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'ready', spec: SPEC, attempt: 2 });
  });

  it('with review off, sets the goal and sends the message by itself', async () => {
    const { runtime, writer, openCode, goals, promptSent, statuses } = createRuntime();
    await runtime.create(job({ review: false, tokenBudget: 50_000 }));

    writeAnswer(writer);
    await runtime.whenIdle();

    expect(goals).toEqual([expect.objectContaining({
      sessionID: SESSION,
      directory: DIRECTORY,
      objective: SPEC,
      tokenBudget: 50_000,
      goalWriterSettings: { rewriteAll: false },
    })]);
    expect(openCode.state.calls).toEqual([
      { route: 'model', body: { model: { id: 'claude', providerID: 'anthropic', variant: 'high' } } },
      { route: 'agent', body: { agent: 'build' } },
      { route: 'prompt', body: { text: 'add dark mode' } },
      { route: 'synthetic', body: { text: buildGoalIntroText(50_000, SPEC), resume: false } },
    ]);
    expect(promptSent).toEqual([SESSION]);
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'sent', outcome: { kind: 'spec', sendMode: 'with-message' } });
    expect(statuses()).toEqual(['writing', 'ready', 'ready', 'sent']);
  });

  it('sends the spec itself as the message in goal-as-message mode', async () => {
    const { runtime, writer, openCode } = createRuntime();
    await runtime.create(job({ review: false, sendMode: 'goal-as-message' }));
    writeAnswer(writer);
    await runtime.whenIdle();

    expect(openCode.state.calls.filter((call) => call.route !== 'model' && call.route !== 'agent')).toEqual([
      { route: 'prompt', body: { text: SPEC } },
      { route: 'synthetic', body: { text: buildGoalIntroText(null, null), resume: false } },
    ]);
  });

  it('sends the instructions derived from the text before the prompt, with the agent mention', async () => {
    const { runtime, writer, openCode } = createRuntime();
    await runtime.create(job({
      review: false,
      message: {
        content: '@review add dark mode',
        text: 'add dark mode',
        agentMention: 'review',
        attachments: [],
        context: [{ kind: 'instruction', text: '<system-reminder>Load the skill</system-reminder>' }],
      },
    }));
    writeAnswer(writer);
    await runtime.whenIdle();

    expect(openCode.state.calls.map((call) => call.route)).toEqual(['model', 'agent', 'synthetic', 'prompt', 'synthetic']);
    expect(openCode.state.calls[2].body).toEqual({ text: '<system-reminder>Load the skill</system-reminder>', resume: false });
    expect(openCode.state.calls[3].body).toEqual({ text: 'add dark mode', agents: [{ name: 'review' }] });
  });

  it('Send original stops the writer; an armed goal keeps the message as its objective', async () => {
    const { runtime, writer, openCode, goals } = createRuntime();
    const created = await runtime.create(job({ trigger: 'armed' }));

    const sent = await runtime.send(created.job.id, { kind: 'original' });

    expect(writer.calls[0].input.signal.aborted).toBe(true);
    expect(sent.job).toMatchObject({ status: 'sent', outcome: { kind: 'original', withGoal: true } });
    expect(goals).toEqual([expect.objectContaining({ objective: 'add dark mode' })]);
    expect(openCode.state.calls.map((call) => call.route)).toEqual(['model', 'agent', 'prompt', 'synthetic']);

    // A late answer from the stopped write changes nothing.
    writeAnswer(writer);
    await runtime.whenIdle();
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'sent', spec: null });
  });

  it('Send original of a goal from the next message sends it without a goal', async () => {
    const { runtime, openCode, goals } = createRuntime();
    const created = await runtime.create(job({ trigger: 'auto-create' }));

    const sent = await runtime.send(created.job.id, { kind: 'original' });

    expect(sent.job.outcome).toEqual({ kind: 'original', withGoal: false });
    expect(goals).toEqual([]);
    expect(openCode.state.calls.map((call) => call.route)).toEqual(['model', 'agent', 'prompt']);
  });

  it('sends the spec as edited on the card', async () => {
    const { runtime, writer, goals, openCode } = createRuntime();
    const created = await runtime.create(job());
    writeAnswer(writer);
    await runtime.whenIdle();

    await expect(runtime.send(created.job.id, { kind: 'spec', sendMode: 'goal-as-message', spec: '' })).rejects.toThrow();
    const sent = await runtime.send(created.job.id, { kind: 'spec', sendMode: 'goal-as-message', spec: '## Objective\nEdited' });

    expect(sent.job).toMatchObject({ status: 'sent', spec: '## Objective\nEdited', outcome: { kind: 'spec', sendMode: 'goal-as-message' } });
    expect(goals[0].objective).toBe('## Objective\nEdited');
    expect(openCode.state.calls.find((call) => call.route === 'prompt').body).toEqual({ text: '## Objective\nEdited' });
  });

  it('a failed send keeps the job open with the reason and review on', async () => {
    const openCode = createOpenCode();
    openCode.state.failPath = /\/prompt$/;
    const { runtime, writer } = createRuntime({ openCode });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runtime.create(job({ review: false }));
    writeAnswer(writer);
    await runtime.whenIdle();
    warn.mockRestore();

    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'ready', review: true, sending: false });
    expect(runtime.snapshot().jobs[0].error).toContain('failed with 500');
  });

  it('a message with an attachment waits for the composer even with review off', async () => {
    const { runtime, writer, openCode } = createRuntime();
    const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' };
    const created = await runtime.create(job({
      review: false,
      message: { content: 'add dark mode', text: 'add dark mode', attachments: [attachment], context: [] },
    }));
    expect(created.job.composerOnly).toBe(true);
    // Projections never carry the payload.
    expect(created.job.message.attachments).toEqual([{ id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3 }]);

    writeAnswer(writer);
    await runtime.whenIdle();
    expect(runtime.snapshot().jobs[0].status).toBe('ready');
    expect(openCode.state.calls).toEqual([]);
    await expect(runtime.send(created.job.id, { kind: 'spec', sendMode: 'with-message', spec: SPEC })).rejects.toMatchObject({ status: 409 });

    const claimed = await runtime.claim(created.job.id, { kind: 'spec' });
    expect(claimed.message.attachments[0].dataUrl).toBe('data:image/png;base64,AAA=');
    expect(claimed.job.sending).toBe(true);
    await expect(runtime.edit(created.job.id)).rejects.toMatchObject({ status: 409 });

    const settled = await runtime.settle(created.job.id, { outcome: { kind: 'spec', sendMode: 'with-message' }, spec: SPEC });
    expect(settled.job).toMatchObject({ status: 'sent', sending: false, outcome: { kind: 'spec', sendMode: 'with-message' } });
  });

  it('a composer that claimed the original and failed leaves a job that can be written again', async () => {
    const { runtime, writer } = createRuntime({ settings: {} });
    const created = await runtime.create(job({
      message: { content: 'x', text: 'add dark mode', attachments: [], context: [{ kind: 'synthetic', text: 'conflict notes' }] },
    }));
    await runtime.claim(created.job.id, { kind: 'original' });
    expect(writer.calls[0].input.signal.aborted).toBe(true);

    const released = await runtime.settle(created.job.id, { outcome: null, error: 'network down' });
    expect(released.job).toMatchObject({ status: 'failed', error: 'network down', sending: false, review: true });
  });

  it('an abandoned claim expires', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, writer } = createRuntime({ claimTtlMs: 1_000 });
      const created = await runtime.create(job({
        message: { content: 'x', text: 'add dark mode', attachments: [], context: [{ kind: 'synthetic', text: 'notes' }] },
      }));
      writeAnswer(writer);
      await runtime.whenIdle();
      await runtime.claim(created.job.id, { kind: 'spec' });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'ready', sending: false, error: 'the message was not sent' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('Back to edit cancels the job and hands the whole message back', async () => {
    const { runtime, writer, broadcasts } = createRuntime();
    const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' };
    const created = await runtime.create(job({
      message: { content: '@review add dark mode', text: 'add dark mode', agentMention: 'review', attachments: [attachment], context: [] },
    }));

    const edited = await runtime.edit(created.job.id);

    expect(writer.calls[0].input.signal.aborted).toBe(true);
    expect(edited.job.status).toBe('cancelled');
    expect(edited.message).toMatchObject({ content: '@review add dark mode', attachments: [expect.objectContaining({ dataUrl: attachment.dataUrl })] });
    expect(broadcasts.at(-1).properties.job.status).toBe('cancelled');
    expect(runtime.snapshot().jobs).toEqual([]);
  });

  it('a write stopped by Send original does not come back while the composer sends', async () => {
    const { runtime, writer, broadcasts } = createRuntime();
    const created = await runtime.create(job({
      message: { content: 'x', text: 'add dark mode', attachments: [], context: [{ kind: 'synthetic', text: 'conflict notes' }] },
    }));
    await runtime.claim(created.job.id, { kind: 'original' });

    // The model answers after all, while the composer is still sending.
    writer.calls[0].resolve({ spec: 'stale', providerID: 'p', modelID: 'm' });
    await runtime.whenIdle();

    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'writing', spec: null, sending: true });
    expect(broadcasts.some((event) => event.properties.job?.spec === 'stale')).toBe(false);
  });

  it('keeps one open job per session and replaces a sent one', async () => {
    const { runtime, writer } = createRuntime();
    const first = await runtime.create(job());
    await expect(runtime.create(job())).rejects.toMatchObject({ status: 409 });

    await runtime.send(first.job.id, { kind: 'original' });
    writeAnswer(writer, 0);
    await expect(runtime.dismiss('missing')).rejects.toMatchObject({ status: 404 });
    const second = await runtime.create(job());
    expect(runtime.snapshot().jobs.map((entry) => entry.id)).toEqual([second.job.id]);
    await expect(runtime.dismiss(second.job.id)).rejects.toMatchObject({ status: 409 });
    writeAnswer(writer, 1);
    await runtime.whenIdle();
  });

  it('dismissing a sent card removes it', async () => {
    const { runtime, broadcasts } = createRuntime();
    const created = await runtime.create(job());
    await runtime.send(created.job.id, { kind: 'original' });

    await runtime.dismiss(created.job.id);

    expect(runtime.snapshot().jobs).toEqual([]);
    expect(broadcasts.at(-1).properties).toMatchObject({ sessionId: SESSION, job: null });
  });

  it('a deleted session cancels its job and stops the writer', async () => {
    const { runtime, writer, emit, broadcasts } = createRuntime();
    runtime.start();
    await runtime.load();
    await runtime.create(job());

    emit({ type: 'session.deleted', properties: { info: { id: SESSION } } });

    expect(writer.calls[0].input.signal.aborted).toBe(true);
    expect(broadcasts.at(-1).properties.job.status).toBe('cancelled');
    expect(runtime.snapshot().jobs).toEqual([]);
  });

  it('jobs survive a restart, and a write the restart cut off starts again', async () => {
    const dataDir = makeDataDir();
    const first = createRuntime({ dataDir });
    await first.runtime.create(job());
    await first.runtime.flush();
    first.runtime.stop();

    const second = createRuntime({ dataDir });
    second.runtime.start();
    await second.runtime.load();
    await vi.waitFor(() => expect(second.writer.calls).toHaveLength(1));
    expect(second.runtime.snapshot().jobs[0]).toMatchObject({ status: 'writing', message: { text: 'add dark mode' } });
    writeAnswer(second.writer);
    await second.runtime.whenIdle();
    expect(second.runtime.snapshot().jobs[0].status).toBe('ready');
  });

  it('moves a malformed jobs file aside instead of overwriting it', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'goal-spec-jobs.json'), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { runtime } = createRuntime({ dataDir });
    await runtime.load();
    warn.mockRestore();

    expect(runtime.snapshot().jobs).toEqual([]);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('goal-spec-jobs.json.corrupt-'))).toBe(true);
  });

  it('refuses a job without text or without a model', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.create(job({ message: { content: '', text: '  ', attachments: [], context: [] } }))).rejects.toThrow(TypeError);
    await expect(runtime.create(job({ sendConfig: {} }))).rejects.toThrow(TypeError);
  });
});

describe('goal writer job routes', () => {
  const createApp = (runtime) => {
    const app = express();
    app.use(express.json());
    registerGoalSpecJobRoutes(app, runtime);
    return app;
  };

  it('starts a job, answers the snapshot, and maps refusals to their status', async () => {
    const { runtime, writer } = createRuntime();
    const app = createApp(runtime);

    const created = await request(app).post('/api/goals/spec-jobs').send(job()).expect(200);
    expect(created.body.job).toMatchObject({ sessionId: SESSION, status: 'writing' });

    const snapshot = await request(app).get('/api/goals/spec-jobs').expect(200);
    expect(snapshot.body).toMatchObject({ revision: 1, jobs: [{ id: created.body.job.id }] });

    await request(app).post('/api/goals/spec-jobs').send(job()).expect(409);
    await request(app).post('/api/goals/spec-jobs').send({ sessionId: SESSION }).expect(400);
    await request(app).post(`/api/goals/spec-jobs/${created.body.job.id}/send`).send({ kind: 'spec', sendMode: 'with-message', spec: SPEC }).expect(409);
    await request(app).post('/api/goals/spec-jobs/missing/redo').expect(404);

    writeAnswer(writer);
    await runtime.whenIdle();
    const edited = await request(app).post(`/api/goals/spec-jobs/${created.body.job.id}/edit`).expect(200);
    expect(edited.body.message.text).toBe('add dark mode');
  });
});
