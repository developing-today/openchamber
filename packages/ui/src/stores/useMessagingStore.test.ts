import { afterAll, afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
});

type Handler = (request: Request) => Promise<Response>;
let handler: Handler = async (request) => {
  throw new Error(`Unexpected request: ${request.url}`);
};
const requests: Request[] = [];
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init);
  requests.push(request);
  return handler(request);
});

const { useMessagingStore } = await import('./useMessagingStore');

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const created = () => ({ topic: 'ses_b/user', seq: 2, kind: 'message', type: 'status', writer: 'ses_b', time: 20, preview: 'new', inbox: true });

const message = (seq: number, data: string) => ({
  id: seq, topic: 'ses_b/user', seq, kind: 'message', type: 'user', writer: 'ses_b', time: seq * 10, data,
});

beforeEach(() => {
  requests.length = 0;
  useMessagingStore.getState().reset();
});

afterEach(() => {
  useMessagingStore.getState().reset();
  jest.useRealTimers();
});

afterAll(() => {
  fetchSpy.mockRestore();
  browser.close();
});

test('checks support once and treats a missing route as unsupported', async () => {
  handler = async () => new Response('not found', { status: 404 });
  expect(await useMessagingStore.getState().checkSupport()).toEqual({ kind: 'unsupported' });
  expect(await useMessagingStore.getState().checkSupport()).toEqual({ kind: 'unsupported' });
  expect(requests).toHaveLength(1);
});

test('the inbox reads messages to the person without moving any read position', async () => {
  handler = async () => Response.json({ data: { messages: [message(2, 'second'), message(1, 'first')], more: false } });
  await useMessagingStore.getState().loadInbox();
  expect(useMessagingStore.getState().inbox).toMatchObject({ key: 'inbox', loading: false, error: null });
  expect(useMessagingStore.getState().inbox.data?.map((item) => item.data)).toEqual(['second', 'first']);
  expect(await requests[0]?.json()).toEqual({ inbox: true, order: 'desc', limit: 100, markRead: false });
});

test('a failed refresh keeps what was on screen and says why', async () => {
  handler = async () => Response.json({ data: { messages: [message(1, 'kept')], more: false } });
  await useMessagingStore.getState().loadInbox();
  handler = async () => Response.json({ _tag: 'UnknownError', message: 'database locked' }, { status: 500 });
  await useMessagingStore.getState().loadInbox();
  const inbox = useMessagingStore.getState().inbox;
  expect(inbox.data?.map((item) => item.data)).toEqual(['kept']);
  expect(inbox.error).toBe('database locked');
});

test('only the newest read of a slice commits', async () => {
  const pending: Array<(response: Response) => void> = [];
  const started = deferred<void>();
  handler = () => new Promise((resolve) => {
    pending.push(resolve);
    if (pending.length === 2) started.resolve();
  });
  const first = useMessagingStore.getState().loadInbox();
  const second = useMessagingStore.getState().loadInbox();
  // Both requests are in flight before either answers.
  await started.promise;
  pending[1]?.(Response.json({ data: { messages: [message(2, 'newer')], more: false } }));
  await second;
  pending[0]?.(Response.json({ data: { messages: [message(1, 'older')], more: false } }));
  await first;
  expect(useMessagingStore.getState().inbox.data?.map((item) => item.data)).toEqual(['newer']);
});

test('a soft write limit comes back as refused, and force sends it anyway', async () => {
  handler = async () => Response.json({ _tag: 'ConflictError', message: 'only the owner writes' }, { status: 409 });
  expect(await useMessagingStore.getState().sendToTopic('ses_a/private', 'note')).toEqual({ kind: 'refused', policy: 'only the owner writes' });
  handler = async () => Response.json({ data: { topic: 'ses_a/private', seq: 4, created: false, forced: true, delivered: [] } });
  const sent = await useMessagingStore.getState().sendToTopic('ses_a/private', 'note', { force: true });
  expect(sent).toMatchObject({ kind: 'sent', result: { seq: 4, forced: true } });
  expect(await requests.at(-1)?.json()).toEqual({ topic: 'ses_a/private', text: 'note', force: true });
});

test('a thread page reads newest first and shows oldest first', async () => {
  handler = async () => Response.json({ data: { messages: [message(3, 'c'), message(2, 'b')], more: true } });
  useMessagingStore.getState().openTopicAt('ses_b/user');
  await useMessagingStore.getState().loadThread('ses_b/user');
  expect(useMessagingStore.getState().thread.data).toMatchObject({ more: true, messages: [{ data: 'b' }, { data: 'c' }] });
  handler = async () => Response.json({ data: { messages: [message(1, 'a')], more: false } });
  await useMessagingStore.getState().loadThread('ses_b/user', { more: true });
  expect(useMessagingStore.getState().thread.data?.messages.map((item) => item.data)).toEqual(['a', 'b', 'c']);
  // Earlier pages ask for what comes before the first message shown.
  expect(await requests.at(-1)?.json()).toMatchObject({ before: 2, order: 'desc' });
});

test('message bursts do no reads while hidden and refresh once when a view opens', async () => {
  jest.useFakeTimers();
  handler = async () => Response.json({ data: { messages: [message(1, 'initial')], more: false } });
  await useMessagingStore.getState().loadInbox();
  for (let index = 0; index < 100; index++) useMessagingStore.getState().applyCreated(created());
  jest.runOnlyPendingTimers();
  expect(requests).toHaveLength(1);

  const refreshed = deferred<void>();
  const unsubscribe = useMessagingStore.subscribe((state) => {
    if (state.inbox.data?.[0]?.data === 'updated') refreshed.resolve();
  });
  handler = async () => Response.json({ data: { messages: [message(2, 'updated')], more: false } });
  const release = useMessagingStore.getState().mountView();
  try {
    jest.runOnlyPendingTimers();
    await refreshed.promise;
    expect(requests).toHaveLength(2);
  } finally {
    release();
    unsubscribe();
  }
});

test('closing the last view cancels its debounce and keeps the refresh for reopening', async () => {
  jest.useFakeTimers();
  handler = async () => Response.json({ data: { messages: [], more: false } });
  await useMessagingStore.getState().loadInbox();
  const release = useMessagingStore.getState().mountView();
  useMessagingStore.getState().applyCreated(created());
  release();
  jest.runOnlyPendingTimers();
  expect(requests).toHaveLength(1);
  const refreshed = deferred<void>();
  const unsubscribe = useMessagingStore.subscribe((state) => {
    if (!state.inbox.loading && requests.length === 2) refreshed.resolve();
  });
  const reopen = useMessagingStore.getState().mountView();
  try {
    jest.runOnlyPendingTimers();
    await refreshed.promise;
    expect(requests).toHaveLength(2);
  } finally {
    reopen();
    unsubscribe();
  }
});

test('a support check from before reset cannot replace the new runtime verdict', async () => {
  const started = deferred<void>();
  const done = deferred<Response>();
  handler = async () => { started.resolve(); return done.promise; };
  const old = useMessagingStore.getState().checkSupport();
  await started.promise;
  useMessagingStore.getState().reset();
  handler = async () => new Response(null, { status: 404 });
  await useMessagingStore.getState().checkSupport();
  done.resolve(Response.json({ data: { state: 'ready' } }));
  await old;
  expect(useMessagingStore.getState().support).toEqual({ kind: 'unsupported' });
});
