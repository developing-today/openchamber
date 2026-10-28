import { describe, expect, mock, test } from 'bun:test';

let getImpl: (() => Promise<Response>) | null = null;
let putImpl: (() => Promise<Response>) | null = null;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (_url: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') {
      if (putImpl) return putImpl();
      throw new Error('unexpected PUT in disabledProviders test');
    }
    if (getImpl) return getImpl();
    throw new Error('unexpected GET in disabledProviders test');
  }),
}));

const {
  loadDisabledProviders,
  peekDisabledProviders,
  rememberDisabledProviders,
  setProviderDisabled,
} = await import('./disabledProviders');

const providersResponse = (providers: string[]) => new Response(JSON.stringify({ providers }), {
  headers: { 'Content-Type': 'application/json' },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

describe('disabledProviders read/write ordering (#659)', () => {
  test('a read started before a turn-off toggle cannot overwrite or answer with the pre-toggle list', async () => {
    rememberDisabledProviders([]);
    const pendingRead = deferred<Response>();
    getImpl = () => pendingRead.promise;
    putImpl = async () => providersResponse(['groq']);

    const load = loadDisabledProviders();
    expect(await setProviderDisabled('groq', true)).toEqual(['groq']);
    // The in-flight read now resolves with the list from before the toggle.
    pendingRead.resolve(providersResponse([]));

    expect(await load).toEqual(['groq']);
    expect(peekDisabledProviders()).toEqual(['groq']);
  });

  test('a read started before a turn-back-on toggle cannot overwrite or answer with the pre-toggle list', async () => {
    rememberDisabledProviders(['groq']);
    const pendingRead = deferred<Response>();
    getImpl = () => pendingRead.promise;
    putImpl = async () => providersResponse([]);

    const load = loadDisabledProviders();
    expect(await setProviderDisabled('groq', false)).toEqual([]);
    // The in-flight read now resolves with the list from before the toggle.
    pendingRead.resolve(providersResponse(['groq']));

    expect(await load).toEqual([]);
    expect(peekDisabledProviders()).toEqual([]);
  });

  test('an unsuperseded read still commits and answers with its own list', async () => {
    getImpl = async () => providersResponse(['copilot']);
    putImpl = null;

    expect(await loadDisabledProviders()).toEqual(['copilot']);
    expect(peekDisabledProviders()).toEqual(['copilot']);
  });

  test('a failed read still throws and keeps the previous snapshot', async () => {
    rememberDisabledProviders(['copilot']);
    getImpl = async () => new Response('nope', { status: 500 });
    putImpl = null;

    await expect(loadDisabledProviders()).rejects.toThrow('Could not read disabled providers (500)');
    expect(peekDisabledProviders()).toEqual(['copilot']);
  });
});
