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
const JOBS_FILE = 'goal-spec-jobs.json';
const RESTART_REASON = 'the server restarted while the message was being sent; check the session before sending it again';

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

/**
 * A fake OpenCode that records every session call in order. `timeline` also
 * gets the goal and the Auto resolution from the runtime's other doubles, so
 * a test can assert the order across all of them. Reads (is the session
 * running, its newest record, a session's parent) go to `reads` instead:
 * they send nothing.
 */
const createOpenCode = () => {
  const state = {
    calls: [],
    timeline: [],
    reads: [],
    failPath: null,
    down: false,
    readsFail: false,
    hold: null,
    promptAnswer: null,
    // `/api/session/active` lists only running sessions; an absent id is idle.
    active: {},
    // Subagent sessions per parent session.
    children: {},
    // The session's records, newest first.
    records: [],
  };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    if (state.down) throw new TypeError('fetch failed');
    const { pathname } = new URL(url);
    if ((init.method ?? 'GET') === 'GET') {
      state.reads.push(pathname);
      if (state.readsFail) return new Response('unavailable', { status: 503 });
      if (pathname === '/api/session/active') return Response.json({ data: state.active });
      if (pathname.endsWith('/message')) return Response.json({ data: state.records, cursor: {} });
      const id = decodeURIComponent(pathname.split('/').at(-1));
      const parentID = Object.keys(state.children).find((parent) => state.children[parent].includes(id));
      return Response.json({ data: { id, parentID } });
    }
    if (state.hold?.pattern.test(pathname)) {
      state.hold.reached.resolve();
      await state.hold.released.promise;
    }
    if (state.failPath && state.failPath.test(pathname)) {
      return new Response('upstream refused', { status: 500 });
    }
    const route = pathname.split('/').at(-1);
    state.calls.push({ route, body: JSON.parse(init.body) });
    state.timeline.push(route);
    if (route === 'prompt' && state.promptAnswer) return Response.json(state.promptAnswer);
    return Response.json({ data: { id: `msg_${state.calls.length}` } });
  });
  return { state, fetchImpl };
};

/** Holds the requests whose path matches until the test lets them through. */
const holdRoute = (openCode, pattern) => {
  const reached = Promise.withResolvers();
  const released = Promise.withResolvers();
  openCode.state.hold = { pattern, reached, released };
  return { reached: reached.promise, release: () => released.resolve() };
};

/**
 * A writer whose answers the test hands out one call at a time. It goes
 * through OpenCode, so it fails at once while OpenCode is down.
 */
const createWriter = (openCode = null) => {
  const calls = [];
  const writeSpec = vi.fn((input) => new Promise((resolve, reject) => {
    calls.push({ input, resolve, reject });
    if (openCode?.state.down) reject(new Error('OpenCode port is not available'));
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

const composerOnlyMessage = { content: 'x', text: 'add dark mode', attachments: [], context: [{ kind: 'synthetic', text: 'notes' }] };

const createRuntime = ({
  dataDir = makeDataDir(),
  openCode = createOpenCode(),
  writer = createWriter(openCode),
  settings = {},
  claimTtlMs,
  connected = true,
  now,
  resolveAutoSelection,
  sessionKnowledgeRuntime,
  readFollowUpBehavior,
} = {}) => {
  const broadcasts = [];
  const goals = [];
  const promptSent = [];
  const hub = { connected, onEvent: () => {}, onStatus: () => {} };
  const options = {
    globalEventHub: {
      subscribeEvent(handler) { hub.onEvent = handler; return () => {}; },
      subscribeStatus(handler) { hub.onStatus = handler; return () => {}; },
      isConnected: () => hub.connected,
    },
    buildOpenCodeUrl: (fetchPath) => {
      if (openCode.state.down) throw new Error('OpenCode port is not available');
      return `http://opencode.test${fetchPath}`;
    },
    getOpenCodeAuthHeaders: () => ({}),
    broadcastGlobalUiEvent: (event) => broadcasts.push(event),
    persistSessionGoal: vi.fn(),
    onPromptSent: (sessionId) => promptSent.push(sessionId),
    dataDir,
    writeSpec: writer.writeSpec,
    readWriterSettings: () => settings,
    createGoal: async (input) => {
      goals.push(input);
      openCode.state.timeline.push('goal');
      return { goal: { id: 'goal-1' }, spec: null };
    },
    fetchImpl: openCode.fetchImpl,
    // A waiting job looks at its session at once after an idle event, and
    // again soon while a subagent works or OpenCode does not answer.
    turnQuietMs: 0,
    subagentRecheckMs: 20,
    turnRetryDelayMs: () => 20,
  };
  if (claimTtlMs) options.claimTtlMs = claimTtlMs;
  if (now) options.now = now;
  if (resolveAutoSelection) options.resolveAutoSelection = resolveAutoSelection;
  if (sessionKnowledgeRuntime) options.sessionKnowledgeRuntime = sessionKnowledgeRuntime;
  // Without one, the runtime reads the settings file in `dataDir`; none means queue.
  if (readFollowUpBehavior) options.readFollowUpBehavior = readFollowUpBehavior;
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
    emit: (payload) => hub.onEvent({ translated: () => [payload] }),
    /** The hub reaches OpenCode; the runtime hears `connect`. */
    connect: () => {
      hub.connected = true;
      hub.onStatus({ type: 'connect', wasReady: false });
    },
    statuses: () => broadcasts.map((event) => event.properties.job?.status ?? null),
    prompts: () => openCode.state.calls.filter((call) => call.route === 'prompt'),
  };
};

const writeAnswer = (writer, index = writer.calls.length - 1) => {
  writer.calls[index].resolve({ spec: SPEC, providerID: 'openai', modelID: 'gpt-writer' });
};

const jobsFilePath = (dataDir) => path.join(dataDir, JOBS_FILE);
const readJobsFile = (dataDir) => JSON.parse(fs.readFileSync(jobsFilePath(dataDir), 'utf8'));
const backupsIn = (dataDir) => fs.readdirSync(dataDir).filter((name) => name.startsWith(`${JOBS_FILE}.corrupt-`));

/** A job as the file stores it. */
const storedJob = (overrides = {}) => ({
  id: 'goal-spec-stored-1',
  sessionId: SESSION,
  directory: DIRECTORY,
  status: 'ready',
  trigger: 'armed',
  review: false,
  sendMode: 'with-message',
  tokenBudget: null,
  message: { content: 'add dark mode', text: 'add dark mode', attachments: [], context: [] },
  sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build', variant: 'high' },
  writerInput: {},
  spec: SPEC,
  writer: { source: 'session', providerID: 'anthropic', modelID: 'claude', variant: null },
  error: null,
  warning: null,
  delivery: null,
  outcome: null,
  attempt: 1,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
});

const writeStoredFile = (dataDir, contents) => {
  const raw = JSON.stringify(contents);
  fs.writeFileSync(jobsFilePath(dataDir), raw);
  return raw;
};

describe('goal writer jobs', () => {
  it('writes the spec and waits for the user while review is on', async () => {
    const { runtime, writer, broadcasts, openCode } = createRuntime({ settings: { model: 'openai/gpt-writer', variant: 'low' } });

    const created = await runtime.create(job());
    expect(created.job).toMatchObject({ status: 'writing', attempt: 1, sending: false, composerOnly: false, warning: null });
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
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'failed', error: 'No small model available', failedStep: 'write' });

    const redone = await runtime.redo(runtime.snapshot().jobs[0].id);
    expect(redone.job).toMatchObject({ status: 'writing', attempt: 2, error: null, failedStep: null });
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
      providerID: 'anthropic',
      modelID: 'claude',
      goalWriterSettings: { rewriteAll: false },
    })]);
    expect(openCode.state.calls).toEqual([
      { route: 'model', body: { model: { id: 'claude', providerID: 'anthropic', variant: 'high' } } },
      { route: 'agent', body: { agent: 'build' } },
      { route: 'synthetic', body: { text: buildGoalIntroText(50_000, SPEC), resume: false } },
      { route: 'prompt', body: { text: 'add dark mode' } },
    ]);
    expect(promptSent).toEqual([SESSION]);
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'sent', outcome: { kind: 'spec', sendMode: 'with-message' } });
    expect(statuses()).toEqual(['writing', 'ready', 'ready', 'sent']);
  });

  it('keeps as much of the goal as the goal length limit in Settings allows', async () => {
    // The writer writes within that limit; a goal saved at the default 5000
    // would be condensed again by the small model.
    const { runtime, writer, goals } = createRuntime({ settings: { charLimit: 12_000 } });
    await runtime.create(job({ review: false }));

    writeAnswer(writer);
    await runtime.whenIdle();

    expect(goals).toEqual([expect.objectContaining({ objective: SPEC, goalWriterSettings: { rewriteAll: false, charLimit: 12_000 } })]);
  });

  it('every server send puts the goal reminder in before the prompt, so the prompt starts the only turn', async () => {
    // A reminder sent after the prompt reached the agent in the middle of the
    // turn the prompt started, and the agent answered it in a second turn.
    const sentToSession = (openCode) => openCode.state.calls.filter((call) => call.route !== 'model' && call.route !== 'agent');
    const reminderThenPrompt = (briefing) => [
      { route: 'synthetic', body: { text: buildGoalIntroText(null, briefing), resume: false } },
      { route: 'prompt', body: { text: 'add dark mode' } },
    ];

    const onCard = createRuntime();
    const reviewed = await onCard.runtime.create(job());
    writeAnswer(onCard.writer);
    await onCard.runtime.whenIdle();
    await onCard.runtime.send(reviewed.job.id, { kind: 'spec', sendMode: 'with-message', spec: SPEC });
    expect(sentToSession(onCard.openCode)).toEqual(reminderThenPrompt(SPEC));

    const original = createRuntime();
    const writing = await original.runtime.create(job({ trigger: 'armed' }));
    await original.runtime.send(writing.job.id, { kind: 'original' });
    expect(sentToSession(original.openCode)).toEqual(reminderThenPrompt(null));

    const automatic = createRuntime();
    await automatic.runtime.create(job({ trigger: 'auto-create', review: false }));
    writeAnswer(automatic.writer);
    await automatic.runtime.whenIdle();
    expect(sentToSession(automatic.openCode)).toEqual(reminderThenPrompt(SPEC));

    const working = createOpenCode();
    working.state.active = { [SESSION]: { type: 'running' } };
    const queued = createRuntime({ openCode: working });
    const waiting = await queued.runtime.create(job());
    writeAnswer(queued.writer);
    await queued.runtime.whenIdle();
    await queued.runtime.send(waiting.job.id, { kind: 'spec', sendMode: 'with-message', spec: SPEC });
    expect(working.state.calls).toEqual([]);
    working.state.active = {};
    queued.runtime.processPayload({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await vi.waitFor(() => expect(queued.runtime.snapshot().jobs[0].status).toBe('sent'));
    expect(sentToSession(working)).toEqual(reminderThenPrompt(SPEC));
  });

  it('switches model and agent before the goal, writes the project knowledge into the session, and sends instructions and the goal reminder before the prompt', async () => {
    // `sync` writes the session's instruction entries and never throws.
    const knowledge = { sync: vi.fn(async () => true) };
    const { runtime, writer, openCode } = createRuntime({ sessionKnowledgeRuntime: knowledge });
    knowledge.sync.mockImplementation(async () => {
      openCode.state.timeline.push('knowledge');
      return true;
    });
    await runtime.create(job({
      review: false,
      message: {
        content: 'add dark mode',
        text: 'add dark mode',
        attachments: [],
        context: [{ kind: 'instruction', text: '<system-reminder>Load the skill</system-reminder>' }],
      },
    }));
    writeAnswer(writer);
    await runtime.whenIdle();

    expect(openCode.state.timeline).toEqual(['model', 'agent', 'knowledge', 'goal', 'synthetic', 'synthetic', 'prompt']);
    expect(openCode.state.calls.filter((call) => call.route === 'synthetic').map((call) => call.body.text)).toEqual([
      '<system-reminder>Load the skill</system-reminder>',
      buildGoalIntroText(null, SPEC),
    ]);
    expect(knowledge.sync).toHaveBeenCalledWith(SESSION, DIRECTORY);
  });

  it('a failed model switch leaves no goal', async () => {
    const openCode = createOpenCode();
    openCode.state.failPath = /\/model$/;
    const { runtime, writer, goals } = createRuntime({ openCode });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runtime.create(job({ review: false }));
    writeAnswer(writer);
    await runtime.whenIdle();
    warn.mockRestore();

    expect(goals).toEqual([]);
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'ready', review: true, sending: false });
    expect(runtime.snapshot().jobs[0].error).toContain('failed with 500');
  });

  it('resolves Auto before anything else, and the session and the goal get the routed model', async () => {
    const resolveAutoSelection = vi.fn();
    const { runtime, writer, openCode, goals } = createRuntime({ resolveAutoSelection });
    resolveAutoSelection.mockImplementation(async () => {
      openCode.state.timeline.push('auto');
      return { model: { providerID: 'anthropic', id: 'claude-routed', variant: 'max' }, agent: 'plan' };
    });
    await runtime.create(job({ review: false, sendConfig: { providerID: 'openchamber', modelID: 'auto', agent: 'build' } }));
    writeAnswer(writer);
    await runtime.whenIdle();

    expect(resolveAutoSelection).toHaveBeenCalledWith({
      sessionId: SESSION,
      directory: DIRECTORY,
      model: { id: 'auto', providerID: 'openchamber' },
      agent: 'build',
      requestText: 'add dark mode',
    });
    expect(openCode.state.timeline).toEqual(['auto', 'model', 'agent', 'goal', 'synthetic', 'prompt']);
    expect(openCode.state.calls.slice(0, 2)).toEqual([
      { route: 'model', body: { model: { providerID: 'anthropic', id: 'claude-routed', variant: 'max' } } },
      { route: 'agent', body: { agent: 'plan' } },
    ]);
    expect(goals[0]).toMatchObject({ providerID: 'anthropic', modelID: 'claude-routed' });
    expect(runtime.snapshot().jobs[0].status).toBe('sent');
  });

  it('never sends the Auto sentinel when nothing can resolve it', async () => {
    const { runtime, writer, openCode, goals } = createRuntime();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runtime.create(job({ review: false, sendConfig: { providerID: 'openchamber', modelID: 'auto' } }));
    writeAnswer(writer);
    await runtime.whenIdle();
    warn.mockRestore();

    expect(openCode.state.calls).toEqual([]);
    expect(goals).toEqual([]);
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'ready', review: true, error: 'Auto routing is not available on this server' });
  });

  it('sends the spec itself as the message in goal-as-message mode', async () => {
    const { runtime, writer, openCode } = createRuntime();
    await runtime.create(job({ review: false, sendMode: 'goal-as-message' }));
    writeAnswer(writer);
    await runtime.whenIdle();

    expect(openCode.state.calls.filter((call) => call.route !== 'model' && call.route !== 'agent')).toEqual([
      { route: 'synthetic', body: { text: buildGoalIntroText(null, null), resume: false } },
      { route: 'prompt', body: { text: SPEC } },
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

    expect(openCode.state.calls.map((call) => call.route)).toEqual(['model', 'agent', 'synthetic', 'synthetic', 'prompt']);
    expect(openCode.state.calls[2].body).toEqual({ text: '<system-reminder>Load the skill</system-reminder>', resume: false });
    expect(openCode.state.calls[4].body).toEqual({ text: 'add dark mode', agents: [{ name: 'review' }] });
  });

  it('Send original stops the writer; an armed goal keeps the message as its objective', async () => {
    const { runtime, writer, openCode, goals } = createRuntime();
    const created = await runtime.create(job({ trigger: 'armed' }));

    const sent = await runtime.send(created.job.id, { kind: 'original' });

    expect(writer.calls[0].input.signal.aborted).toBe(true);
    expect(sent.job).toMatchObject({ status: 'sent', outcome: { kind: 'original', withGoal: true } });
    expect(goals).toEqual([expect.objectContaining({ objective: 'add dark mode' })]);
    expect(openCode.state.calls.map((call) => call.route)).toEqual(['model', 'agent', 'synthetic', 'prompt']);

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

    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'ready', review: true, sending: false, failedStep: 'send' });
    expect(runtime.snapshot().jobs[0].error).toContain('failed with 500');
  });

  it('a failed Send original while the spec is written is a failed send, not a failed write', async () => {
    const openCode = createOpenCode();
    openCode.state.failPath = /\/prompt$/;
    const { runtime, writer } = createRuntime({ openCode });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const created = await runtime.create(job());

    await expect(runtime.send(created.job.id, { kind: 'original' })).rejects.toMatchObject({ status: 502 });
    warn.mockRestore();

    expect(writer.calls[0].input.signal.aborted).toBe(true);
    // The send stopped the write, so the job has no spec and reads as failed;
    // the step says it was the send.
    const [failed] = runtime.snapshot().jobs;
    expect(failed).toMatchObject({ status: 'failed', failedStep: 'send', spec: null, review: true, sending: false });
    expect(failed.error).toContain('failed with 500');
  });

  it('a prompt OpenCode answers without a queued message is not taken as sent', async () => {
    const openCode = createOpenCode();
    openCode.state.promptAnswer = { data: {} };
    const { runtime, writer } = createRuntime({ openCode });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runtime.create(job({ review: false }));
    writeAnswer(writer);
    await runtime.whenIdle();
    warn.mockRestore();

    expect(runtime.snapshot().jobs[0]).toMatchObject({
      status: 'ready',
      review: true,
      error: 'OpenCode accepted the prompt but returned no queued message',
    });
  });

  it('a goal reminder that cannot be sent does not stop the message: the job is sent, with a warning', async () => {
    const openCode = createOpenCode();
    // The goal reminder is the only synthetic message of this send.
    openCode.state.failPath = /\/synthetic$/;
    const { runtime, writer, promptSent } = createRuntime({ openCode });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const created = await runtime.create(job({ review: false }));
    writeAnswer(writer);
    await runtime.whenIdle();
    warn.mockRestore();

    const [sent] = runtime.snapshot().jobs;
    expect(sent).toMatchObject({ status: 'sent', error: null, review: false, sending: false, outcome: { kind: 'spec', sendMode: 'with-message' } });
    expect(sent.warning).toMatch(/^the goal reminder was not sent: OpenCode POST .*\/synthetic failed with 500/);
    expect(openCode.state.calls.filter((call) => call.route === 'prompt')).toHaveLength(1);
    expect(promptSent).toEqual([SESSION]);
    await expect(runtime.send(created.job.id, { kind: 'original' })).rejects.toMatchObject({ status: 409 });
    await expect(runtime.send(created.job.id, { kind: 'spec', sendMode: 'with-message', spec: SPEC })).rejects.toMatchObject({ status: 409 });
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

  it('a sent job keeps the names and counts its card shows, and drops the payloads', async () => {
    const dataDir = makeDataDir();
    const { runtime, writer } = createRuntime({ dataDir });
    const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' };
    const created = await runtime.create(job({
      writerInput: { conversation: 'User: a long history', openItems: '- [ ] todo' },
      message: {
        content: '@review add dark mode',
        text: 'add dark mode',
        agentMention: 'review',
        attachments: [attachment],
        context: [
          { kind: 'context', text: 'diff --git a/x b/x', metadata: { openchamberContext: { text: 'PR #1' } } },
          { kind: 'instruction', text: '<system-reminder>Load the skill</system-reminder>' },
        ],
      },
    }));
    writeAnswer(writer);
    await runtime.whenIdle();
    const before = runtime.snapshot().jobs[0];

    await runtime.claim(created.job.id, { kind: 'spec' });
    const settled = await runtime.settle(created.job.id, { outcome: { kind: 'spec', sendMode: 'with-message' }, spec: SPEC });
    await runtime.flush();

    expect(settled.job.message).toEqual(before.message);
    expect(settled.job.composerOnly).toBe(true);
    const [stored] = readJobsFile(dataDir).jobs;
    expect(stored.writerInput).toEqual({});
    expect(stored.message).toEqual({
      content: '@review add dark mode',
      text: 'add dark mode',
      agentMention: 'review',
      attachments: [{ id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3 }],
      context: [{ kind: 'instruction', text: '<system-reminder>Load the skill</system-reminder>' }],
      contextCount: 1,
    });
    expect(JSON.stringify(stored)).not.toContain('data:image');
    expect(JSON.stringify(stored)).not.toContain('diff --git');

    // The stripped job reads back as it was written; the file is not set aside.
    const restarted = createRuntime({ dataDir });
    await restarted.runtime.load();
    expect(restarted.runtime.snapshot().jobs).toEqual([settled.job]);
    expect(backupsIn(dataDir)).toEqual([]);
  });

  it('a sent job names the user message it sent: the id OpenCode queued the prompt under, or the one the composer reports', async () => {
    const openCode = createOpenCode();
    openCode.state.promptAnswer = { data: { id: 'msg_from_server' } };
    const byServer = createRuntime({ openCode });
    const written = await byServer.runtime.create(job());
    expect(written.job.messageId).toBeNull();
    writeAnswer(byServer.writer);
    await byServer.runtime.whenIdle();
    const sent = await byServer.runtime.send(written.job.id, { kind: 'spec', sendMode: 'with-message', spec: SPEC });
    expect(sent.job.messageId).toBe('msg_from_server');

    const dataDir = makeDataDir();
    const byComposer = createRuntime({ dataDir });
    const claimed = await byComposer.runtime.create(job({ message: composerOnlyMessage }));
    await byComposer.runtime.claim(claimed.job.id, { kind: 'original' });
    const settled = await byComposer.runtime.settle(claimed.job.id, { outcome: { kind: 'original', withGoal: true }, messageId: 'msg_from_composer' });
    expect(settled.job.messageId).toBe('msg_from_composer');
    await byComposer.runtime.flush();
    const restarted = createRuntime({ dataDir });
    await restarted.runtime.load();
    expect(restarted.runtime.snapshot().jobs[0].messageId).toBe('msg_from_composer');

    // A file written before the field existed reads as no message named.
    const olderDir = makeDataDir();
    writeStoredFile(olderDir, { version: 1, revision: 3, jobs: [storedJob({ status: 'sent', outcome: { kind: 'original', withGoal: true } })] });
    const older = createRuntime({ dataDir: olderDir });
    await older.runtime.load();
    expect(older.runtime.snapshot().jobs[0]).toMatchObject({ status: 'sent', messageId: null });
  });

  it('remembers a job whose session the composer made from a new-session draft', async () => {
    const dataDir = makeDataDir();
    const { runtime } = createRuntime({ dataDir });
    const fromDraft = await runtime.create(job({ newSession: true }));
    const inSession = await runtime.create(job({ sessionId: 'ses_goal_job_2' }));
    expect(fromDraft.job.newSession).toBe(true);
    expect(inSession.job.newSession).toBe(false);
    await expect(runtime.create(job({ sessionId: 'ses_goal_job_3', newSession: 'yes' }))).rejects.toThrow();

    await runtime.flush();
    const restarted = createRuntime({ dataDir });
    await restarted.runtime.load();
    expect(restarted.runtime.snapshot().jobs.map((entry) => [entry.sessionId, entry.newSession])).toEqual([
      [SESSION, true],
      ['ses_goal_job_2', false],
    ]);

    // A file written before the field existed reads as a session that was there already.
    const olderDir = makeDataDir();
    writeStoredFile(olderDir, { version: 1, revision: 3, jobs: [storedJob()] });
    const older = createRuntime({ dataDir: olderDir });
    await older.runtime.load();
    expect(older.runtime.snapshot().jobs[0].newSession).toBe(false);
    expect(backupsIn(olderDir)).toEqual([]);
  });

  it('a composer that claimed the original and failed leaves a job that can be written again', async () => {
    const { runtime, writer } = createRuntime({ settings: {} });
    const created = await runtime.create(job({ message: composerOnlyMessage }));
    await runtime.claim(created.job.id, { kind: 'original' });
    expect(writer.calls[0].input.signal.aborted).toBe(true);

    const released = await runtime.settle(created.job.id, { outcome: null, error: 'network down' });
    expect(released.job).toMatchObject({ status: 'failed', failedStep: 'send', error: 'network down', sending: false, review: true });
  });

  it('an abandoned claim expires and turns review on', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, writer } = createRuntime({ claimTtlMs: 1_000 });
      const created = await runtime.create(job({ review: false, message: composerOnlyMessage }));
      writeAnswer(writer);
      await runtime.whenIdle();
      await runtime.claim(created.job.id, { kind: 'spec' });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'ready', review: true, sending: false, error: 'the message was not sent' });

      // Only a send that went out is believed without the claim.
      await expect(runtime.settle(created.job.id, { outcome: null, error: 'gone' })).rejects.toMatchObject({ status: 409 });
      const late = await runtime.settle(created.job.id, { outcome: { kind: 'spec', sendMode: 'with-message' }, spec: SPEC });
      expect(late.job).toMatchObject({ status: 'sent', sending: false, error: null, outcome: { kind: 'spec', sendMode: 'with-message' } });
      await expect(runtime.settle(created.job.id, { outcome: { kind: 'spec', sendMode: 'with-message' } })).rejects.toMatchObject({ status: 409 });
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
    const created = await runtime.create(job({ message: composerOnlyMessage }));
    await runtime.claim(created.job.id, { kind: 'original' });

    // The model answers after all, while the composer is still sending.
    writer.calls[0].resolve({ spec: 'stale', providerID: 'p', modelID: 'm' });
    await runtime.whenIdle();

    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'writing', spec: null, sending: true });
    expect(broadcasts.some((event) => event.properties.job?.spec === 'stale')).toBe(false);
  });

  it('a write stopped by a claim stays stopped when the hub reconnects', async () => {
    const { runtime, writer, openCode, connect } = createRuntime();
    runtime.start();
    await runtime.load();
    const created = await runtime.create(job({ review: false }));
    await runtime.claim(created.job.id, { kind: 'original' });

    connect();
    await runtime.load();
    expect(writer.calls).toHaveLength(1);
    // The stopped write answers after all; nothing may come of it.
    writer.calls[0].resolve({ spec: 'stale', providerID: 'p', modelID: 'm' });
    await runtime.whenIdle();
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'writing', spec: null, sending: true });

    await runtime.settle(created.job.id, { outcome: { kind: 'original', withGoal: true } });
    connect();
    await runtime.load();
    await runtime.whenIdle();
    expect(writer.calls).toHaveLength(1);
    expect(openCode.state.calls).toEqual([]);
    expect(runtime.snapshot().jobs[0].status).toBe('sent');
  });

  it('Send original under way is not resumed or sent again by a reconnect', async () => {
    const { runtime, writer, openCode, connect, prompts } = createRuntime();
    runtime.start();
    await runtime.load();
    const created = await runtime.create(job({ review: false }));
    const held = holdRoute(openCode, /\/model$/);
    const sending = runtime.send(created.job.id, { kind: 'original' });
    await held.reached;

    connect();
    await runtime.load();
    expect(writer.calls).toHaveLength(1);
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'writing', sending: true });

    held.release();
    await sending;
    writer.calls[0].resolve({ spec: 'stale', providerID: 'p', modelID: 'm' });
    await runtime.whenIdle();
    expect(writer.calls).toHaveLength(1);
    expect(prompts()).toHaveLength(1);
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'sent', spec: null });
  });

  it('a new job replaces the session\'s job, open or sent, but never one being sent', async () => {
    const { runtime, writer, broadcasts } = createRuntime();
    const first = await runtime.create(job());

    const second = await runtime.create(job());
    expect(writer.calls[0].input.signal.aborted).toBe(true);
    expect(broadcasts.map((event) => [event.properties.job?.id, event.properties.job?.status])).toEqual([
      [first.job.id, 'writing'],
      [first.job.id, 'cancelled'],
      [second.job.id, 'writing'],
    ]);
    expect(runtime.snapshot().jobs.map((entry) => entry.id)).toEqual([second.job.id]);

    await runtime.send(second.job.id, { kind: 'original' });
    await expect(runtime.dismiss('missing')).rejects.toMatchObject({ status: 404 });
    const third = await runtime.create(job());
    expect(runtime.snapshot().jobs.map((entry) => entry.id)).toEqual([third.job.id]);
    await expect(runtime.dismiss(third.job.id)).rejects.toMatchObject({ status: 409 });

    await runtime.claim(third.job.id, { kind: 'original' });
    await expect(runtime.create(job())).rejects.toMatchObject({ status: 409 });
    expect(runtime.snapshot().jobs.map((entry) => entry.id)).toEqual([third.job.id]);
    for (const call of writer.calls) call.resolve({ spec: SPEC, providerID: 'p', modelID: 'm' });
    await runtime.whenIdle();
  });

  it('at the cap a sent card makes room before any open job does', async () => {
    let clock = 1_000_000;
    const { runtime, writer } = createRuntime({ now: () => clock++ });
    // 50 is the cap (MAX_JOBS in spec-jobs.js).
    const created = [];
    for (let index = 0; index < 50; index += 1) {
      created.push(await runtime.create(job({ sessionId: `ses_cap_${index}` })));
    }
    await runtime.send(created[1].job.id, { kind: 'original' });

    await runtime.create(job({ sessionId: 'ses_cap_new' }));

    const ids = runtime.snapshot().jobs.map((entry) => entry.id);
    expect(ids).toHaveLength(50);
    expect(ids).toContain(created[0].job.id);
    expect(ids).not.toContain(created[1].job.id);
    expect(writer.calls[0].input.signal.aborted).toBe(false);
  });

  it('at the cap with every job open, the oldest open job is cancelled', async () => {
    let clock = 1_000_000;
    const { runtime, writer, broadcasts } = createRuntime({ now: () => clock++ });
    const created = [];
    for (let index = 0; index < 50; index += 1) {
      created.push(await runtime.create(job({ sessionId: `ses_cap_${index}` })));
    }

    const added = await runtime.create(job({ sessionId: 'ses_cap_new' }));

    expect(added.job.status).toBe('writing');
    const ids = runtime.snapshot().jobs.map((entry) => entry.id);
    expect(ids).toHaveLength(50);
    expect(ids).not.toContain(created[0].job.id);
    expect(ids).toContain(created[1].job.id);
    expect(writer.calls[0].input.signal.aborted).toBe(true);
    expect(broadcasts.some((event) => event.properties.job?.id === created[0].job.id && event.properties.job.status === 'cancelled')).toBe(true);
  });

  it('dismissing a sent card removes it', async () => {
    const { runtime, broadcasts } = createRuntime();
    const created = await runtime.create(job());
    await runtime.send(created.job.id, { kind: 'original' });

    await runtime.dismiss(created.job.id);

    expect(runtime.snapshot().jobs).toEqual([]);
    expect(broadcasts.at(-1).properties).toMatchObject({ sessionId: SESSION, job: null });
  });

  it('a sent card goes a day after it was sent, with no other job to sweep it', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, broadcasts } = createRuntime();
      runtime.start();
      await runtime.load();
      const created = await runtime.create(job());
      await runtime.send(created.job.id, { kind: 'original' });

      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000);
      expect(runtime.snapshot().jobs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(runtime.snapshot().jobs).toEqual([]);
      expect(broadcasts.at(-1).properties).toMatchObject({ sessionId: SESSION, job: null });
    } finally {
      vi.useRealTimers();
    }
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

  it('an archived session ends its job; an unarchive ends nothing', async () => {
    const { runtime, writer, broadcasts } = createRuntime();
    await runtime.create(job());
    const other = await runtime.create(job({ sessionId: 'ses_goal_job_2' }));
    await runtime.send(other.job.id, { kind: 'original' });

    runtime.processPayload({ type: 'openchamber:session-archived', properties: { sessionID: 'ses_goal_job_2', archivedAt: null } });
    expect(runtime.snapshot().jobs).toHaveLength(2);

    runtime.processPayload({ type: 'openchamber:session-archived', properties: { sessionID: SESSION, archivedAt: 5 } });
    expect(writer.calls[0].input.signal.aborted).toBe(true);
    expect(broadcasts.at(-1).properties.job).toMatchObject({ sessionId: SESSION, status: 'cancelled' });

    runtime.processPayload({ type: 'openchamber:session-archived', properties: { sessionID: 'ses_goal_job_2', archivedAt: 6 } });
    expect(broadcasts.at(-1).properties).toMatchObject({ sessionId: 'ses_goal_job_2', job: null });
    expect(runtime.snapshot().jobs).toEqual([]);
  });

  it('an open job follows its session to another directory', async () => {
    const knowledge = { sync: vi.fn(async () => true) };
    const resolveAutoSelection = vi.fn(async () => null);
    const { runtime, writer, emit, goals, broadcasts } = createRuntime({ sessionKnowledgeRuntime: knowledge, resolveAutoSelection });
    runtime.start();
    await runtime.load();
    const created = await runtime.create(job({ review: false }));
    writer.calls[0].reject(new Error('writer down'));
    await runtime.whenIdle();

    emit({ type: 'session.updated', properties: { sessionID: SESSION, info: { id: SESSION, directory: '/repo-moved' } } });
    expect(broadcasts.at(-1).properties.job).toMatchObject({ id: created.job.id, directory: '/repo-moved' });

    await runtime.redo(created.job.id);
    expect(writer.calls[1].input.directory).toBe('/repo-moved');
    writeAnswer(writer, 1);
    await runtime.whenIdle();

    expect(goals[0].directory).toBe('/repo-moved');
    expect(resolveAutoSelection).toHaveBeenCalledWith(expect.objectContaining({ directory: '/repo-moved' }));
    expect(knowledge.sync).toHaveBeenCalledWith(SESSION, '/repo-moved');

    // A sent job is done with its directory.
    emit({ type: 'session.updated', properties: { sessionID: SESSION, info: { id: SESSION, directory: '/elsewhere' } } });
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'sent', directory: '/repo-moved' });
  });

  it('stop() aborts running writes', async () => {
    const { runtime, writer, broadcasts } = createRuntime();
    await runtime.create(job());

    await runtime.stop();

    expect(writer.calls[0].input.signal.aborted).toBe(true);
    writeAnswer(writer);
    await runtime.whenIdle();
    expect(runtime.snapshot().jobs[0].status).toBe('writing');
    expect(broadcasts).toHaveLength(1);
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

  it('a write the restart cut off waits for OpenCode, then the job is written and sent once', async () => {
    const dataDir = makeDataDir();
    const first = createRuntime({ dataDir });
    await first.runtime.create(job({ review: false }));
    await first.runtime.flush();
    first.runtime.stop();

    const openCode = createOpenCode();
    openCode.state.down = true;
    const second = createRuntime({ dataDir, openCode, connected: false });
    second.runtime.start();
    await second.runtime.load();
    await second.runtime.whenIdle();
    expect(second.writer.calls).toHaveLength(0);
    expect(second.runtime.snapshot().jobs[0]).toMatchObject({ status: 'writing', error: null });

    openCode.state.down = false;
    second.connect();
    await vi.waitFor(() => expect(second.writer.calls).toHaveLength(1));
    writeAnswer(second.writer);
    await second.runtime.whenIdle();
    second.connect();
    await second.runtime.load();
    await second.runtime.whenIdle();

    expect(second.writer.calls).toHaveLength(1);
    expect(second.prompts()).toHaveLength(1);
    expect(second.runtime.snapshot().jobs[0]).toMatchObject({ status: 'sent', error: null });
  });

  it('a written spec a restart left unsent goes out once the hub connects, and only once', async () => {
    const dataDir = makeDataDir();
    writeStoredFile(dataDir, { version: 1, revision: 7, jobs: [storedJob()] });
    const { runtime, writer, connect, prompts } = createRuntime({ dataDir, connected: false });
    runtime.start();
    await runtime.load();
    await runtime.whenIdle();
    expect(prompts()).toEqual([]);

    connect();
    connect();
    await runtime.load();
    await runtime.whenIdle();

    expect(prompts()).toEqual([{ route: 'prompt', body: { text: 'add dark mode' } }]);
    expect(writer.calls).toEqual([]);
    expect(runtime.snapshot()).toMatchObject({ jobs: [{ status: 'sent', outcome: { kind: 'spec', sendMode: 'with-message' } }] });
    expect(runtime.snapshot().revision).toBeGreaterThan(7);
  });

  it('a connect during a resumed send does not send it again', async () => {
    const dataDir = makeDataDir();
    writeStoredFile(dataDir, { version: 1, revision: 7, jobs: [storedJob()] });
    const openCode = createOpenCode();
    const held = holdRoute(openCode, /\/model$/);
    const { runtime, connect, prompts } = createRuntime({ dataDir, openCode });
    runtime.start();
    await runtime.load();
    await held.reached;

    connect();
    await runtime.load();
    held.release();
    await runtime.whenIdle();

    expect(prompts()).toHaveLength(1);
    expect(runtime.snapshot().jobs[0].status).toBe('sent');
  });

  it('a send is on record before its first request, and a restart mid-send puts the job back to review', async () => {
    const dataDir = makeDataDir();
    const openCode = createOpenCode();
    const first = createRuntime({ dataDir, openCode });
    await first.runtime.create(job({ review: false }));
    const held = holdRoute(openCode, /\/model$/);
    writeAnswer(first.writer);
    await held.reached;
    expect(readJobsFile(dataDir).jobs[0]).toMatchObject({ status: 'ready', delivery: { by: 'server', startedAt: expect.any(Number) } });
    // The process dies here: the held request never answers.

    const second = createRuntime({ dataDir });
    second.runtime.start();
    await second.runtime.load();
    second.connect();
    await second.runtime.load();
    await second.runtime.whenIdle();

    expect(second.runtime.snapshot().jobs[0]).toMatchObject({ status: 'ready', review: true, sending: false, error: RESTART_REASON });
    expect(second.openCode.state.calls).toEqual([]);
    await second.runtime.flush();
    expect(readJobsFile(dataDir).jobs[0]).toMatchObject({ delivery: null, review: true, error: RESTART_REASON });
  });

  it('a claim is on record too: after a restart the job waits, and the composer\'s late report still lands', async () => {
    const dataDir = makeDataDir();
    const first = createRuntime({ dataDir });
    const created = await first.runtime.create(job({ review: false }));
    await first.runtime.claim(created.job.id, { kind: 'original' });
    expect(readJobsFile(dataDir).jobs[0].delivery).toMatchObject({ by: 'composer' });
    first.runtime.stop();

    const second = createRuntime({ dataDir });
    second.runtime.start();
    await second.runtime.load();
    second.connect();
    await second.runtime.load();
    await second.runtime.whenIdle();

    expect(second.writer.calls).toEqual([]);
    expect(second.openCode.state.calls).toEqual([]);
    expect(second.runtime.snapshot().jobs[0]).toMatchObject({ status: 'failed', failedStep: 'send', review: true, sending: false, error: RESTART_REASON });
    const settled = await second.runtime.settle(created.job.id, { outcome: { kind: 'original', withGoal: true } });
    expect(settled.job).toMatchObject({ status: 'sent', error: null, outcome: { kind: 'original', withGoal: true } });
  });

  it('writes the jobs file readable by its owner only, with no temp file left behind', async () => {
    const dataDir = makeDataDir();
    const { runtime } = createRuntime({ dataDir });
    await runtime.create(job());
    await runtime.flush();

    expect(fs.readdirSync(dataDir)).toEqual([JOBS_FILE]);
    if (process.platform !== 'win32') expect(fs.statSync(jobsFilePath(dataDir)).mode & 0o777).toBe(0o600);
    expect(readJobsFile(dataDir)).toMatchObject({ version: 1, revision: 1, jobs: [{ sessionId: SESSION, status: 'writing' }] });
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

  it.each([
    ['jobs that are not a list', { version: 1, revision: 3, jobs: { first: storedJob() } }],
    ['an unknown version', { version: 2, revision: 3, jobs: [storedJob()] }],
    ['no version', { revision: 3, jobs: [storedJob()] }],
  ])('moves a file with %s aside and never writes over it', async (_label, contents) => {
    const dataDir = makeDataDir();
    const raw = writeStoredFile(dataDir, contents);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { runtime } = createRuntime({ dataDir });
    await runtime.load();
    warn.mockRestore();
    expect(runtime.snapshot().jobs).toEqual([]);

    await runtime.create(job({ sessionId: 'ses_goal_job_new' }));
    await runtime.flush();
    const backups = backupsIn(dataDir);
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe(raw);
    expect(readJobsFile(dataDir).jobs.map((entry) => entry.sessionId)).toEqual(['ses_goal_job_new']);
  });

  it('keeps the valid jobs of a file with a bad one, and keeps the original bytes beside it', async () => {
    const dataDir = makeDataDir();
    const raw = writeStoredFile(dataDir, {
      version: 1,
      revision: 3,
      jobs: [storedJob({ review: true }), storedJob({ id: 'goal-spec-bad', sessionId: 'ses_goal_job_2', tokenBudget: 'lots' })],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { runtime } = createRuntime({ dataDir });
    await runtime.load();
    await runtime.flush();
    warn.mockRestore();

    expect(runtime.snapshot().jobs.map((entry) => entry.id)).toEqual(['goal-spec-stored-1']);
    const backups = backupsIn(dataDir);
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dataDir, backups[0]), 'utf8')).toBe(raw);
    expect(readJobsFile(dataDir).jobs.map((entry) => entry.id)).toEqual(['goal-spec-stored-1']);
  });

  it('a jobs file that cannot be read fails the load, and every change is refused', async () => {
    const dataDir = makeDataDir();
    // A directory where the file should be: every read fails with EISDIR.
    fs.mkdirSync(jobsFilePath(dataDir));
    const { runtime } = createRuntime({ dataDir });
    const app = express();
    app.use(express.json());
    registerGoalSpecJobRoutes(app, runtime);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runtime.create(job())).rejects.toMatchObject({ code: 'EISDIR' });
    await request(app).get('/api/goals/spec-jobs').expect(500);
    error.mockRestore();
    expect(runtime.snapshot().jobs).toEqual([]);
    expect(fs.statSync(jobsFilePath(dataDir)).isDirectory()).toBe(true);
  });

  it('refuses a job without text or without a model', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.create(job({ message: { content: '', text: '  ', attachments: [], context: [] } }))).rejects.toThrow(TypeError);
    await expect(runtime.create(job({ sendConfig: {} }))).rejects.toThrow(TypeError);
  });

  it('refuses scheduled-task provenance, and a token budget or writer input it cannot use', async () => {
    const { runtime, writer } = createRuntime();
    await expect(runtime.create(job({
      sendConfig: {},
      message: { content: 'x', text: 'add dark mode', attachments: [], context: [], scheduledTask: { projectId: 'p1', taskId: 't1' } },
    }))).rejects.toThrow('scheduledTask is server-owned');
    for (const tokenBudget of ['lots', -5, 1.5, 0]) {
      await expect(runtime.create(job({ tokenBudget }))).rejects.toThrow();
    }
    for (const writerInput of ['history', { conversation: 42 }, { openItems: ['a'] }]) {
      await expect(runtime.create(job({ writerInput }))).rejects.toThrow();
    }
    expect(writer.calls).toEqual([]);
    expect(runtime.snapshot().jobs).toEqual([]);
  });
});

const statusEvent = (type, sessionID = SESSION) => ({ type: 'session.status', properties: { sessionID, status: { type } } });
// Long enough for the zero-delay looks and the 20 ms rechecks createRuntime sets.
const afterLooks = async (runtime) => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  await runtime.whenIdle();
};
const writtenJob = async (runtime, writer, overrides = {}) => {
  const created = await runtime.create(job(overrides));
  writeAnswer(writer);
  await runtime.whenIdle();
  return created.job;
};

describe('a server send while the agent works', () => {
  it('with queue, the message waits for the turn to end, then goes out once', async () => {
    const openCode = createOpenCode();
    openCode.state.active = { [SESSION]: { type: 'running' } };
    const { runtime, writer, goals, prompts, dataDir } = createRuntime({ openCode });
    const written = await writtenJob(runtime, writer);

    const edited = '## Objective\nEdited';
    const waiting = await runtime.send(written.id, { kind: 'spec', sendMode: 'goal-as-message', spec: edited });

    expect(waiting.job).toMatchObject({ status: 'ready', waiting: true, sending: false });
    // Nothing reached the session yet: no switch, no goal, no prompt.
    expect(openCode.state.calls).toEqual([]);
    expect(goals).toEqual([]);
    await runtime.flush();
    expect(readJobsFile(dataDir).jobs[0]).toMatchObject({
      delivery: null,
      waiting: { choice: { kind: 'spec', sendMode: 'goal-as-message', spec: edited } },
    });
    // While it waits, only Back to edit changes it.
    await expect(runtime.send(written.id, { kind: 'original' })).rejects.toMatchObject({ status: 409 });
    await expect(runtime.redo(written.id)).rejects.toMatchObject({ status: 409 });
    await expect(runtime.claim(written.id, { kind: 'spec' })).rejects.toMatchObject({ status: 409 });

    runtime.processPayload(statusEvent('busy'));
    await afterLooks(runtime);
    expect(prompts()).toEqual([]);

    openCode.state.active = {};
    runtime.processPayload(statusEvent('idle'));
    await vi.waitFor(() => expect(runtime.snapshot().jobs[0].status).toBe('sent'));
    // A later idle event finds nothing left to send.
    runtime.processPayload(statusEvent('idle'));
    await afterLooks(runtime);

    expect(prompts()).toEqual([{ route: 'prompt', body: { text: edited } }]);
    expect(goals).toEqual([expect.objectContaining({ objective: edited })]);
    expect(runtime.snapshot().jobs[0]).toMatchObject({ waiting: false, sending: false, outcome: { kind: 'spec', sendMode: 'goal-as-message' } });
  });

  it('with steer, the message goes out at once into the running turn', async () => {
    const openCode = createOpenCode();
    openCode.state.active = { [SESSION]: { type: 'running' } };
    const { runtime, prompts } = createRuntime({ openCode, readFollowUpBehavior: () => 'steer' });
    const created = await runtime.create(job());

    const sent = await runtime.send(created.job.id, { kind: 'original' });

    expect(sent.job).toMatchObject({ status: 'sent', waiting: false });
    expect(prompts()).toHaveLength(1);
    // Steer never asks whether the agent is working.
    expect(openCode.state.reads).toEqual([]);
  });

  it.each([
    ['steer', { followUpBehavior: 'steer' }, { status: 'sent', waiting: false }],
    ['the removed immediate', { followUpBehavior: 'immediate' }, { status: 'sent', waiting: false }],
    ['the legacy queue mode turned off', { queueModeEnabled: false }, { status: 'sent', waiting: false }],
    ['queue', { followUpBehavior: 'queue' }, { waiting: true, sending: false }],
    ['no setting', {}, { waiting: true, sending: false }],
  ])('reads the follow-up setting from the settings file: %s', async (_label, settingsFile, expected) => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settingsFile));
    const openCode = createOpenCode();
    openCode.state.active = { [SESSION]: { type: 'running' } };
    const { runtime } = createRuntime({ dataDir, openCode });
    const created = await runtime.create(job());

    const result = await runtime.send(created.job.id, { kind: 'original' });

    expect(result.job).toMatchObject(expected);
  });

  it('a written spec that sends itself waits too, and Back to edit takes it back unsent', async () => {
    const openCode = createOpenCode();
    openCode.state.active = { [SESSION]: { type: 'running' } };
    const { runtime, writer, prompts, broadcasts } = createRuntime({ openCode });
    const written = await writtenJob(runtime, writer, { review: false });

    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'ready', waiting: true, sending: false });
    expect(broadcasts.at(-1).properties.job).toMatchObject({ waiting: true });

    const edited = await runtime.edit(written.id);
    expect(edited.job).toMatchObject({ status: 'cancelled', waiting: false });
    openCode.state.active = {};
    runtime.processPayload(statusEvent('idle'));
    await afterLooks(runtime);
    expect(prompts()).toEqual([]);
  });

  it('a waiting message survives a restart and goes out once the turn is over, once', async () => {
    const dataDir = makeDataDir();
    const busy = createOpenCode();
    busy.state.active = { [SESSION]: { type: 'running' } };
    const first = createRuntime({ dataDir, openCode: busy });
    const written = await writtenJob(first.runtime, first.writer);
    await first.runtime.send(written.id, { kind: 'spec', sendMode: 'with-message', spec: SPEC });
    await first.runtime.flush();
    first.runtime.stop();

    const second = createRuntime({ dataDir, connected: false });
    second.runtime.start();
    await second.runtime.load();
    // Nothing went out, so the job waits on; it is not put back to review.
    expect(second.runtime.snapshot().jobs[0]).toMatchObject({ status: 'ready', waiting: true, sending: false, review: true, error: null });
    expect(second.openCode.state.reads).toEqual([]);

    second.connect();
    await vi.waitFor(() => expect(second.prompts()).toHaveLength(1));
    second.connect();
    await afterLooks(second.runtime);

    expect(second.prompts()).toEqual([{ route: 'prompt', body: { text: 'add dark mode' } }]);
    expect(second.runtime.snapshot().jobs[0]).toMatchObject({ status: 'sent', waiting: false, outcome: { kind: 'spec', sendMode: 'with-message' } });
  });

  it('an idle event while the message goes out does not send it again', async () => {
    const openCode = createOpenCode();
    const { runtime, writer, prompts } = createRuntime({ openCode });
    const written = await writtenJob(runtime, writer);
    const held = holdRoute(openCode, /\/model$/);

    // The session is idle, so the send starts at once and stops at the model switch.
    const sending = runtime.send(written.id, { kind: 'original' });
    await held.reached;
    runtime.processPayload(statusEvent('idle'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    held.release();
    await sending;
    await afterLooks(runtime);

    expect(prompts()).toHaveLength(1);
    expect(runtime.snapshot().jobs[0]).toMatchObject({ status: 'sent', waiting: false });
  });

  it('a composer\'s late report that the message went out ends the wait, so the server never sends it too', async () => {
    const openCode = createOpenCode();
    openCode.state.active = { [SESSION]: { type: 'running' } };
    const { runtime, writer, prompts } = createRuntime({ openCode });
    const written = await writtenJob(runtime, writer);
    await runtime.send(written.id, { kind: 'original' });

    // A send that finished after its claim expired is taken for any open job.
    const settled = await runtime.settle(written.id, { outcome: { kind: 'original', withGoal: true } });
    expect(settled.job).toMatchObject({ status: 'sent', waiting: false });

    openCode.state.active = {};
    runtime.processPayload(statusEvent('idle'));
    await afterLooks(runtime);
    expect(prompts()).toEqual([]);
  });

  it('a subagent still at work holds the message until it is done', async () => {
    const openCode = createOpenCode();
    openCode.state.active = { ses_goal_child: { type: 'running' } };
    openCode.state.children = { [SESSION]: ['ses_goal_child'] };
    const { runtime, writer, prompts } = createRuntime({ openCode });
    const written = await writtenJob(runtime, writer);

    expect((await runtime.send(written.id, { kind: 'original' })).job.waiting).toBe(true);
    await afterLooks(runtime);
    expect(prompts()).toEqual([]);

    // No idle event for the parent: the recheck finds the subagent done.
    openCode.state.active = {};
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
  });

  it('a reply still streaming holds the message although OpenCode lists nothing running, and its finish sends it', async () => {
    const openCode = createOpenCode();
    const { runtime, writer, prompts } = createRuntime({ openCode });
    const written = await writtenJob(runtime, writer);
    const created = Date.now();
    openCode.state.records = [{ type: 'assistant', time: { created } }];

    expect((await runtime.send(written.id, { kind: 'original' })).job.waiting).toBe(true);
    await afterLooks(runtime);
    expect(prompts()).toEqual([]);

    // The reply finishes; its update ends the wait without an idle event.
    openCode.state.records = [{ type: 'assistant', time: { created, completed: created + 1 } }];
    runtime.processPayload({ type: 'message.updated', properties: { info: { role: 'assistant', sessionID: SESSION, time: { completed: created + 1 } } } });
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
  });

  it('a reply left unfinished before this server started does not hold the message', async () => {
    const openCode = createOpenCode();
    openCode.state.records = [{ type: 'assistant', time: { created: 1 } }];
    const { runtime, writer, prompts } = createRuntime({ openCode });
    const written = await writtenJob(runtime, writer);

    const sent = await runtime.send(written.id, { kind: 'original' });

    expect(sent.job.status).toBe('sent');
    expect(prompts()).toHaveLength(1);
  });

  it('a session OpenCode cannot answer for holds the message, which goes out once OpenCode answers', async () => {
    const openCode = createOpenCode();
    const { runtime, writer, prompts } = createRuntime({ openCode });
    const written = await writtenJob(runtime, writer);
    openCode.state.readsFail = true;

    expect((await runtime.send(written.id, { kind: 'original' })).job.waiting).toBe(true);
    await afterLooks(runtime);
    expect(prompts()).toEqual([]);
    // Asked again, with no event needed.
    expect(openCode.state.reads.filter((read) => read === '/api/session/active').length).toBeGreaterThan(1);

    openCode.state.readsFail = false;
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
  });
});

// A message with attachments or attached context goes out from the window
// that claimed it, after the same wait.
describe('a composer\'s claim while the agent works', () => {
  const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' };
  const withAttachment = { content: 'add dark mode', text: 'add dark mode', attachments: [attachment], context: [] };
  const busyOpenCode = () => {
    const openCode = createOpenCode();
    openCode.state.active = { [SESSION]: { type: 'running' } };
    return openCode;
  };

  it('with queue, the claim waits for the turn to end and is handed to its composer then, once', async () => {
    const openCode = busyOpenCode();
    const { runtime, writer, broadcasts, dataDir } = createRuntime({ openCode });
    const written = await writtenJob(runtime, writer, { message: withAttachment });

    const claimed = await runtime.claim(written.id, { kind: 'spec' });

    // The composer keeps the whole message; the job waits under the claim's id.
    expect(claimed.message.attachments[0].dataUrl).toBe(attachment.dataUrl);
    expect(claimed.job).toMatchObject({ status: 'ready', waiting: true, sending: false, claimId: expect.stringMatching(/^claim-/) });
    const { claimId } = claimed.job;
    await runtime.flush();
    expect(readJobsFile(dataDir).jobs[0]).toMatchObject({ delivery: null, waiting: { claimId } });
    // Nothing else sends it while it waits.
    await expect(runtime.claim(written.id, { kind: 'original' })).rejects.toMatchObject({ status: 409 });
    await expect(runtime.redo(written.id)).rejects.toMatchObject({ status: 409 });

    runtime.processPayload(statusEvent('busy'));
    await afterLooks(runtime);
    expect(runtime.snapshot().jobs[0]).toMatchObject({ waiting: true, sending: false });

    openCode.state.active = {};
    runtime.processPayload(statusEvent('idle'));
    await vi.waitFor(() => expect(runtime.snapshot().jobs[0]).toMatchObject({ waiting: false, sending: true, claimId }));
    // A later idle event finds nothing left to hand over.
    const handedOver = broadcasts.length;
    runtime.processPayload(statusEvent('idle'));
    await afterLooks(runtime);
    expect(broadcasts).toHaveLength(handedOver);
    await runtime.flush();
    expect(readJobsFile(dataDir).jobs[0]).toMatchObject({ waiting: null, delivery: { by: 'composer', claimId } });

    // The server sends nothing itself; the composer reports its send.
    expect(openCode.state.calls).toEqual([]);
    const settled = await runtime.settle(written.id, { outcome: { kind: 'spec', sendMode: 'with-message' }, spec: SPEC });
    expect(settled.job).toMatchObject({ status: 'sent', sending: false, waiting: false, claimId: null });
  });

  it('with steer, the claim is handed over at once', async () => {
    const openCode = busyOpenCode();
    const { runtime, writer } = createRuntime({ openCode, readFollowUpBehavior: () => 'steer' });
    const written = await writtenJob(runtime, writer, { message: withAttachment });

    const claimed = await runtime.claim(written.id, { kind: 'spec' });

    expect(claimed.job).toMatchObject({ waiting: false, sending: true, claimId: expect.stringMatching(/^claim-/) });
    // Steer never asks whether the agent is working.
    expect(openCode.state.reads).toEqual([]);
  });

  it('a waiting claim does not expire; its time runs from the hand-over', async () => {
    const openCode = busyOpenCode();
    const { runtime, writer, broadcasts } = createRuntime({ openCode, claimTtlMs: 30 });
    const written = await writtenJob(runtime, writer, { message: withAttachment });
    await runtime.claim(written.id, { kind: 'spec' });

    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(runtime.snapshot().jobs[0]).toMatchObject({ waiting: true, sending: false, error: null });

    openCode.state.active = {};
    runtime.processPayload(statusEvent('idle'));
    // Its composer never reports: the claim expires as any claim does.
    await vi.waitFor(() => expect(runtime.snapshot().jobs[0]).toMatchObject({
      sending: false, waiting: false, review: true, failedStep: 'send', error: 'the message was not sent', claimId: null,
    }));
    expect(broadcasts.slice(-3).map(({ properties: { job: state } }) => [state.waiting, state.sending, state.error])).toEqual([
      [true, false, null],
      [false, true, null],
      [false, false, 'the message was not sent'],
    ]);
  });

  it('Back to edit takes a waiting claim back, and the end of the turn hands nothing over', async () => {
    const openCode = busyOpenCode();
    const { runtime, writer, broadcasts } = createRuntime({ openCode });
    const written = await writtenJob(runtime, writer, { message: withAttachment });
    await runtime.claim(written.id, { kind: 'spec' });

    const edited = await runtime.edit(written.id);

    expect(edited.job).toMatchObject({ status: 'cancelled', waiting: false, claimId: null });
    expect(edited.message.attachments[0].dataUrl).toBe(attachment.dataUrl);
    const afterEdit = broadcasts.length;
    openCode.state.active = {};
    runtime.processPayload(statusEvent('idle'));
    await afterLooks(runtime);
    expect(broadcasts).toHaveLength(afterEdit);
    expect(runtime.snapshot().jobs).toEqual([]);
  });

  it('a waiting claim survives a restart and is handed over once the turn is over', async () => {
    const dataDir = makeDataDir();
    const first = createRuntime({ dataDir, openCode: busyOpenCode() });
    const written = await writtenJob(first.runtime, first.writer, { message: withAttachment });
    const claimed = await first.runtime.claim(written.id, { kind: 'spec' });
    await first.runtime.flush();
    first.runtime.stop();

    const second = createRuntime({ dataDir, connected: false });
    second.runtime.start();
    await second.runtime.load();
    // Nothing went out, so the claim waits on; it is not put back to review.
    expect(second.runtime.snapshot().jobs[0]).toMatchObject({ waiting: true, sending: false, error: null, claimId: claimed.job.claimId });

    second.connect();
    await vi.waitFor(() => expect(second.runtime.snapshot().jobs[0]).toMatchObject({ waiting: false, sending: true, claimId: claimed.job.claimId }));
    expect(second.openCode.state.calls).toEqual([]);
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

    const first = await request(app).post('/api/goals/spec-jobs').send(job()).expect(200);
    expect(first.body.job).toMatchObject({ sessionId: SESSION, status: 'writing' });

    const snapshot = await request(app).get('/api/goals/spec-jobs').expect(200);
    expect(snapshot.body).toMatchObject({ revision: 1, jobs: [{ id: first.body.job.id }] });

    const created = await request(app).post('/api/goals/spec-jobs').send(job()).expect(200);
    expect(created.body.job.id).not.toBe(first.body.job.id);
    await request(app).post('/api/goals/spec-jobs').send({ sessionId: SESSION }).expect(400);
    await request(app).post('/api/goals/spec-jobs').send(job({ tokenBudget: 'lots' })).expect(400);
    await request(app).post('/api/goals/spec-jobs').send(job({ writerInput: { conversation: 42 } })).expect(400);
    await request(app).post('/api/goals/spec-jobs')
      .send(job({ message: { content: 'x', text: 'x', attachments: [], context: [], scheduledTask: { projectId: 'p', taskId: 't' } } }))
      .expect(400);
    await request(app).post(`/api/goals/spec-jobs/${created.body.job.id}/send`).send({ kind: 'spec', sendMode: 'with-message', spec: SPEC }).expect(409);
    await request(app).post('/api/goals/spec-jobs/missing/redo').expect(404);

    // The replaced job's write was stopped; its late answer is dropped.
    writeAnswer(writer, 0);
    writeAnswer(writer);
    await runtime.whenIdle();
    expect(runtime.snapshot().jobs.map((entry) => [entry.id, entry.status])).toEqual([[created.body.job.id, 'ready']]);
    const edited = await request(app).post(`/api/goals/spec-jobs/${created.body.job.id}/edit`).expect(200);
    expect(edited.body.message.text).toBe('add dark mode');
  });
});
