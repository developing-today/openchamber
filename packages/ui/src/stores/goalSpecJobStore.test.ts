import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { selectInputHistoryEntries, useInputHistoryStore } from './useInputHistoryStore';
import { goalSpecJobChoices, useGoalSpecJobStore, type GoalSpecJob } from './goalSpecJobStore';

type Call = { method: string; path: string; body: ReturnType<typeof JSON.parse> };

const job = (overrides: Partial<GoalSpecJob> = {}): GoalSpecJob => ({
  id: 'job-1',
  sessionId: 'ses_one',
  directory: '/repo',
  status: 'writing',
  trigger: 'armed',
  review: true,
  sendMode: 'with-message',
  tokenBudget: null,
  message: { content: 'Add dark mode', text: 'Add dark mode', attachments: [], contextCount: 0 },
  composerOnly: false,
  spec: null,
  writer: { source: 'settings', providerID: 'p', modelID: 'm', variant: 'high' },
  sendConfig: { providerID: 'p', modelID: 'm' },
  error: null,
  sending: false,
  outcome: null,
  attempt: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const deferred = () => {
  let settle: ((response: Response) => void) | null = null;
  const promise = new Promise<Response>((resolve) => { settle = resolve; });
  return {
    promise,
    resolve: (response: Response) => {
      if (!settle) throw new Error('The deferred response was not set up');
      settle(response);
    },
  };
};

const originalFetch = globalThis.fetch;
let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response> = () => Response.json({ revision: 0, jobs: [] });

const jobs = () => useGoalSpecJobStore.getState().jobs;
const apply = (sessionId: string, value: GoalSpecJob | null, revision: number) => (
  useGoalSpecJobStore.getState().applyServerJob(sessionId, value, revision, getRuntimeKey())
);

beforeEach(() => {
  calls = [];
  respond = () => Response.json({ revision: 0, jobs: [] });
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const call: Call = { method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    return respond(call);
  }, originalFetch);
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://goal-jobs.test' });
  useGoalSpecJobStore.getState().resetForRuntimeSwitch();
  useInputHistoryStore.setState({ globalBuckets: {}, sessionBuckets: {} });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  configureRuntimeUrlResolver({ apiBaseUrl: '' });
});

describe('goal writer jobs in the client', () => {
  test('the snapshot shows each session\'s job', async () => {
    respond = () => Response.json({ revision: 4, jobs: [job(), job({ id: 'job-2', sessionId: 'ses_two', status: 'ready', spec: 'Spec' })] });
    await useGoalSpecJobStore.getState().hydrate();

    expect(calls).toEqual([{ method: 'GET', path: '/api/goals/spec-jobs', body: undefined }]);
    expect(jobs().ses_one?.status).toBe('writing');
    expect(jobs().ses_two?.spec).toBe('Spec');
  });

  test('a job read from the server keeps the step that failed and whether it waits for the agent', async () => {
    // The schema drops what it does not name, and the card titles and locks by these.
    respond = () => Response.json({
      revision: 4,
      jobs: [
        job({ status: 'failed', error: 'OpenCode is not reachable', failedStep: 'send' }),
        job({ id: 'job-2', sessionId: 'ses_two', status: 'ready', spec: 'Spec', waiting: true }),
      ],
    });
    await useGoalSpecJobStore.getState().hydrate();

    expect(jobs().ses_one?.failedStep).toBe('send');
    expect(jobs().ses_two?.waiting).toBe(true);
  });

  test('an event older than the job on screen never replaces it', () => {
    apply('ses_one', job({ status: 'ready', spec: 'Spec' }), 5);
    apply('ses_one', job({ status: 'writing' }), 4);
    expect(jobs().ses_one?.status).toBe('ready');

    apply('ses_one', job({ status: 'sent', spec: 'Spec', outcome: { kind: 'spec', sendMode: 'with-message' } }), 6);
    expect(jobs().ses_one?.status).toBe('sent');
  });

  test('an event that arrives while the snapshot is read wins over it, and one older than the snapshot is dropped', async () => {
    const read = deferred();
    respond = () => read.promise;
    const hydration = useGoalSpecJobStore.getState().hydrate();
    // Written after the server took its snapshot (revision 10), before the answer arrived.
    apply('ses_one', job({ status: 'ready', spec: 'Spec' }), 11);
    read.resolve(Response.json({ revision: 10, jobs: [job({ status: 'writing' })] }));
    await hydration;
    expect(jobs().ses_one?.status).toBe('ready');

    apply('ses_two', job({ id: 'job-2', sessionId: 'ses_two' }), 9);
    expect(jobs().ses_two).toBeUndefined();
  });

  test('a later snapshot drops the jobs the server no longer has', async () => {
    respond = () => Response.json({ revision: 3, jobs: [job()] });
    await useGoalSpecJobStore.getState().hydrate();
    respond = () => Response.json({ revision: 7, jobs: [] });
    await useGoalSpecJobStore.getState().resync();
    expect(jobs().ses_one).toBeUndefined();
  });

  test('Write again sends the choices made on the card, and from then on the job holds them', async () => {
    const written = job({ status: 'ready', spec: 'Spec' });
    apply('ses_one', written, 1);
    const choices = { writerChoice: { providerID: 'p', modelID: 'm', variant: 'low' }, ignoreLimit: true };
    useGoalSpecJobStore.getState().setChoiceEdit(written, choices);
    respond = () => Response.json({ revision: 2, job: { ...written, status: 'writing', spec: null, attempt: 2, ...choices } });

    await useGoalSpecJobStore.getState().redoJob(written, choices);

    expect(calls).toEqual([{ method: 'POST', path: '/api/goals/spec-jobs/job-1/redo', body: choices }]);
    // The server's job shows them now: an edit kept here would hide a change made in another window.
    expect(useGoalSpecJobStore.getState().choiceEdits).toEqual({});
    const current = jobs().ses_one;
    if (!current) throw new Error('The job left the store');
    expect(goalSpecJobChoices(current, undefined)).toEqual(choices);
  });

  test('choices made on a card leave with its job, replaced or gone from a snapshot', async () => {
    const choices = { writerChoice: null, ignoreLimit: true };
    const first = job();
    apply('ses_one', first, 1);
    useGoalSpecJobStore.getState().setChoiceEdit(first, choices);
    apply('ses_one', job({ id: 'job-2' }), 2);
    expect(useGoalSpecJobStore.getState().choiceEdits).toEqual({});

    const second = job({ id: 'job-3', sessionId: 'ses_two' });
    apply('ses_two', second, 3);
    useGoalSpecJobStore.getState().setChoiceEdit(second, choices);
    respond = () => Response.json({ revision: 7, jobs: [job({ id: 'job-2' })] });
    await useGoalSpecJobStore.getState().resync();
    expect(useGoalSpecJobStore.getState().choiceEdits).toEqual({});
  });

  test('a cancelled job and a dismissed one leave the chat', () => {
    apply('ses_one', job(), 1);
    apply('ses_one', job({ status: 'cancelled' }), 2);
    expect(jobs().ses_one).toBeUndefined();

    apply('ses_two', job({ id: 'job-2', sessionId: 'ses_two', status: 'sent' }), 3);
    apply('ses_two', null, 4);
    expect(jobs().ses_two).toBeUndefined();
  });

  test('a failed read keeps the cards as they were', async () => {
    apply('ses_one', job({ status: 'ready', spec: 'Spec' }), 2);
    respond = () => Response.json({ error: 'down' }, { status: 503 });
    await expect(useGoalSpecJobStore.getState().resync()).rejects.toThrow('down');
    expect(jobs().ses_one?.spec).toBe('Spec');
  });

  test('a reconnect during a read earns one more read, however many arrive', async () => {
    const first = deferred();
    const answers: Array<Response | Promise<Response>> = [first.promise, Response.json({ revision: 8, jobs: [job({ status: 'ready', spec: 'Spec' })] })];
    respond = () => answers.shift() ?? Response.json({ revision: 99, jobs: [] });
    const hydration = useGoalSpecJobStore.getState().hydrate();
    void useGoalSpecJobStore.getState().resync();
    void useGoalSpecJobStore.getState().resync();
    first.resolve(Response.json({ revision: 5, jobs: [job()] }));
    await hydration;

    expect(calls).toHaveLength(2);
    expect(jobs().ses_one?.status).toBe('ready');
  });

  test('a runtime switch clears the cards and drops a read started before it', async () => {
    apply('ses_one', job(), 1);
    const read = deferred();
    respond = () => read.promise;
    const hydration = useGoalSpecJobStore.getState().hydrate();
    useGoalSpecJobStore.getState().resetForRuntimeSwitch();
    expect(jobs()).toEqual({});
    read.resolve(Response.json({ revision: 2, jobs: [job({ status: 'ready', spec: 'Spec' })] }));
    await hydration;
    expect(jobs()).toEqual({});
  });

  test('starting a job posts the captured message with its send settings and keeps the prompt in history', async () => {
    respond = () => Response.json({ revision: 1, job: job() });
    await useGoalSpecJobStore.getState().startJob({
      expectedRuntimeKey: getRuntimeKey(),
      sessionId: 'ses_one',
      directory: '/repo',
      trigger: 'auto-create',
      review: false,
      sendMode: 'goal-as-message',
      tokenBudget: 5000,
      writerInput: { conversation: 'User:\nEarlier' },
      newSession: true,
      message: { content: '@build Add dark mode', text: 'Add dark mode', agentMention: 'build', context: [{ kind: 'instruction', text: 'Load the skill' }] },
      sendConfig: { providerID: 'p', modelID: 'm', agent: 'build', variant: 'high' },
    });

    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/goals/spec-jobs',
      body: {
        sessionId: 'ses_one',
        directory: '/repo',
        trigger: 'auto-create',
        review: false,
        sendMode: 'goal-as-message',
        tokenBudget: 5000,
        writerInput: { conversation: 'User:\nEarlier' },
        newSession: true,
        message: {
          content: '@build Add dark mode',
          text: 'Add dark mode',
          agentMention: 'build',
          attachments: [],
          context: [{ kind: 'instruction', text: 'Load the skill' }],
          sendConfig: { providerID: 'p', modelID: 'm', agent: 'build', variant: 'high' },
        },
        sendConfig: { providerID: 'p', modelID: 'm', agent: 'build', variant: 'high' },
      },
    });
    expect(jobs().ses_one?.id).toBe('job-1');
    const history = selectInputHistoryEntries(useInputHistoryStore.getState(), { runtimeKey: getRuntimeKey(), directory: '/repo', sessionId: 'ses_one' });
    expect(history.map((entry) => entry.text)).toEqual(['@build Add dark mode']);
  });

  // The composer takes the message, then reads the response style and the
  // writer's context before the start: a switch in between would post the
  // message under its session id to the server now active.
  test('a start after a switch away from the runtime the message was taken on is refused and posts nothing', async () => {
    await expect(useGoalSpecJobStore.getState().startJob({
      expectedRuntimeKey: `${getRuntimeKey()}-before-the-switch`,
      sessionId: 'ses_one',
      directory: '/repo',
      trigger: 'armed',
      review: true,
      sendMode: 'with-message',
      tokenBudget: null,
      writerInput: null,
      newSession: false,
      message: { content: 'Add dark mode', text: 'Add dark mode' },
      sendConfig: { providerID: 'p', modelID: 'm' },
    })).rejects.toThrow('the runtime changed');

    expect(calls).toEqual([]);
    expect(jobs()).toEqual({});
  });

  test('back to edit hands back the whole message, files included', async () => {
    apply('ses_one', job({ status: 'ready', spec: 'Spec', composerOnly: true }), 1);
    respond = () => Response.json({
      revision: 2,
      job: job({ status: 'cancelled' }),
      message: {
        content: 'Look at this',
        text: 'Look at this',
        attachments: [{ id: 'a1', filename: 'note.txt', mimeType: 'text/plain', size: 2, source: 'local', dataUrl: 'data:text/plain;base64,aGk=' }],
        context: [{ kind: 'synthetic', text: 'Resolve the conflict' }],
      },
    });
    const message = await useGoalSpecJobStore.getState().editJob(job({ status: 'ready', spec: 'Spec', composerOnly: true }));

    expect(calls[0]).toEqual({ method: 'POST', path: '/api/goals/spec-jobs/job-1/edit', body: undefined });
    expect(message.content).toBe('Look at this');
    expect(message.context).toEqual([{ kind: 'synthetic', text: 'Resolve the conflict' }]);
    expect(await message.attachments[0]?.file.text()).toBe('hi');
    expect(jobs().ses_one).toBeUndefined();
  });

  test('a refused action reports the server\'s reason and reads the server again', async () => {
    apply('ses_one', job(), 1);
    respond = (call) => (call.method === 'POST'
      ? Response.json({ error: 'the goal spec is not ready' }, { status: 409 })
      : Response.json({ revision: 3, jobs: [job({ status: 'ready', spec: 'Spec' })] }));
    await expect(useGoalSpecJobStore.getState().sendJob(job(), { kind: 'spec', sendMode: 'with-message', spec: 'Spec' }))
      .rejects.toThrow('the goal spec is not ready');
    for (let turn = 0; turn < 20 && jobs().ses_one?.status !== 'ready'; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /api/goals/spec-jobs/job-1/send',
      'GET /api/goals/spec-jobs',
    ]);
    expect(calls[0]?.body).toEqual({ kind: 'spec', sendMode: 'with-message', spec: 'Spec' });
    expect(jobs().ses_one?.status).toBe('ready');
  });
});
