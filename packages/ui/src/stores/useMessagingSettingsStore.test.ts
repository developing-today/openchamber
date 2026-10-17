import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { MessagingConfig } from '@/lib/messagingConfigApi';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  CustomEvent: browser.CustomEvent,
});

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

type Handler = (request: Request) => Promise<Response>;
let handler: Handler = async (request) => { throw new Error(`Unexpected request: ${request.url}`); };
const requests: Request[] = [];
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init);
  if (new URL(request.url).pathname === '/auth/url-token') return new Response(null, { status: 403 });
  requests.push(request);
  return handler(request);
});
const warn = spyOn(console, 'warn').mockImplementation(() => {});

const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { useMessagingSettingsStore } = await import('./useMessagingSettingsStore');
const state = () => useMessagingSettingsStore.getState();
const snapshot = (messaging: MessagingConfig) => Response.json({ messaging, path: '/config/opencode.json', projectPath: null });
const config = () => {
  const current = state().config;
  if (current.kind !== 'ready') throw new Error('Expected ready config');
  return current.snapshot.config;
};
const variables = (session: string) => Response.json({ data: {
  presets: [], vars: [{ name: 'session_id', kind: 'context', description: 'Current session', value: session }],
} });
let runtime = 0;
const nextRuntime = () => switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost', runtimeKey: `messaging-settings-${++runtime}` });

beforeEach(() => {
  nextRuntime();
  requests.length = 0;
});

afterAll(() => {
  fetchSpy.mockRestore();
  warn.mockRestore();
  browser.close();
});

test('serializes optimistic config writes and waits for them before reading', async () => {
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const firstDone = deferred<Response>();
  const secondDone = deferred<Response>();
  const writes: MessagingConfig[] = [];
  let persisted: MessagingConfig = {};
  handler = async (request) => {
    if (request.method === 'GET') return snapshot(persisted);
    const body: { messaging: MessagingConfig } = await request.json();
    writes.push(body.messaging);
    (writes.length === 1 ? firstStarted : secondStarted).resolve();
    const response = await (writes.length === 1 ? firstDone : secondDone).promise;
    if (response.ok) persisted = body.messaging;
    return response;
  };
  await state().load(null);
  const first = state().update((current) => ({ ...current, delivery: { direct: 'inbox' } }));
  const second = state().update((current) => ({ ...current, session_start: 'newer' }));
  await firstStarted.promise;
  expect(writes).toEqual([{ delivery: { direct: 'inbox' } }]);
  expect(config()).toEqual({ delivery: { direct: 'inbox' }, session_start: 'newer' });
  const refresh = state().load(null);
  expect(requests.filter((request) => request.method === 'GET')).toHaveLength(1);
  firstDone.resolve(new Response(null, { status: 204 }));
  expect(await first).toBe(true);
  await secondStarted.promise;
  expect(writes[1]).toEqual({ delivery: { direct: 'inbox' }, session_start: 'newer' });
  secondDone.resolve(new Response(null, { status: 204 }));
  expect(await second).toBe(true);
  await refresh;
  expect(config()).toEqual(persisted);
  expect(config().session_start).toBe('newer');
});

test('a read begun before a mutation cannot replace the newer saved config', async () => {
  handler = async () => snapshot({ session_start: 'initial' });
  await state().load(null);
  const started = deferred<void>();
  const done = deferred<Response>();
  handler = async (request) => {
    if (request.method === 'PUT') return new Response(null, { status: 204 });
    started.resolve();
    return done.promise;
  };
  const refresh = state().load(null);
  await started.promise;
  expect(await state().update((current) => ({ ...current, session_start: 'newer' }))).toBe(true);
  done.resolve(snapshot({ session_start: 'initial' }));
  await refresh;
  expect(config().session_start).toBe('newer');
});

test('successive failed writes roll back to the last server-confirmed config', async () => {
  handler = async () => snapshot({ session_start: 'initial' });
  await state().load(null);
  handler = async () => Response.json({ error: 'read-only config' }, { status: 500 });
  const first = state().update((current) => ({ ...current, session_start: 'first' }));
  const second = state().update((current) => ({ ...current, session_start: 'second' }));
  expect(await Promise.all([first, second])).toEqual([false, false]);
  expect(config()).toEqual({ session_start: 'initial' });
});

test('a runtime switch retires queued writes and old completions cannot replace the new host', async () => {
  handler = async () => snapshot({ session_start: 'old host' });
  await state().load(null);
  const started = deferred<void>();
  const done = deferred<Response>();
  handler = async (request) => {
    if (request.method === 'GET') return snapshot({ session_start: 'new host' });
    started.resolve();
    return done.promise;
  };
  const first = state().update((current) => ({ ...current, session_start: 'first' }));
  const second = state().update((current) => ({ ...current, session_start: 'queued' }));
  await started.promise;
  nextRuntime();
  await state().load(null);
  done.resolve(new Response(null, { status: 204 }));
  expect(await Promise.all([first, second])).toEqual([true, false]);
  expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  expect(config().session_start).toBe('new host');
});

test('variable reads clear another session immediately and retain only same-session data on failure', async () => {
  handler = async () => variables('ses_a');
  await state().loadVars('ses_a');
  expect(state().vars.data?.vars[0]?.value).toBe('ses_a');
  const done = deferred<Response>();
  handler = async () => done.promise;
  const load = state().loadVars('ses_b');
  expect(state().vars.data).toBeNull();
  done.resolve(Response.json({ message: 'unreachable' }, { status: 500 }));
  await load;
  expect(state().vars.data).toBeNull();
  expect(state().vars.error).toBe('unreachable');
  handler = async () => variables('ses_b');
  await state().loadVars('ses_b');
  handler = async () => Response.json({ message: 'offline' }, { status: 500 });
  await state().loadVars('ses_b');
  expect(state().vars.data?.vars[0]?.value).toBe('ses_b');
  expect(state().vars.error).toBe('offline');
});

test('an old variable write cannot refresh variables after a runtime or session switch', async () => {
  handler = async () => variables('ses_a');
  await state().loadVars('ses_a');
  const started = deferred<void>();
  const done = deferred<Response>();
  handler = async (request) => {
    if (request.method === 'PUT') {
      started.resolve();
      return done.promise;
    }
    return variables('ses_current');
  };
  const write = state().setGlobalVar('team', 'core', 'ses_a');
  await started.promise;
  nextRuntime();
  await state().loadVars('ses_current');
  done.resolve(new Response(null, { status: 204 }));
  expect(await write).toBe(true);
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2);
  expect(state().vars.data?.vars[0]?.value).toBe('ses_current');
});

test('a model read superseding start settles the starting flag on success and failure', async () => {
  const started = deferred<void>();
  const done = deferred<Response>();
  handler = async (request) => {
    if (request.method === 'POST') {
      started.resolve();
      return done.promise;
    }
    return Response.json({ data: { state: 'ready', tier: 'tiny' } });
  };
  const start = state().startModel();
  await started.promise;
  expect(state().model.starting).toBe(true);
  await state().loadModel();
  expect(state().model).toMatchObject({ starting: false, status: { state: 'ready', tier: 'tiny' } });
  done.resolve(Response.json({ data: { state: 'starting' } }));
  await start;
  expect(state().model.status?.state).toBe('ready');

  const failedStartDone = deferred<Response>();
  handler = async (request) => request.method === 'POST'
    ? failedStartDone.promise
    : Response.json({ message: 'offline' }, { status: 500 });
  const failedStart = state().startModel();
  await state().loadModel();
  expect(state().model).toMatchObject({ starting: false, error: 'offline' });
  failedStartDone.resolve(Response.json({ data: { state: 'starting' } }));
  await failedStart;
  expect(state().model.starting).toBe(false);
});
