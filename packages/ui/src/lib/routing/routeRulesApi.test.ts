import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { downloadLocalModel, fetchLocalModel, saveRouteSettings } from './routeRulesApi';

type Sent = { url: string; method: string; body: string };

const sent: Sent[] = [];
let respond: (request: Sent) => Response = () => new Response('', { status: 500 });

const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  sent.length = 0;
  spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request: Sent = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? String(init.body) : '' };
    sent.push(request);
    return respond(request);
  });
});

afterEach(() => {
  mock.restore();
  respond = () => new Response('', { status: 500 });
});

const settings = {
  stages: { keywords: true, local: false, external: true },
  learnAfter: 4,
  waitPercentile: 25,
  waitMinSamples: 5,
};

const localModel = {
  label: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
  bytes: 1117320736,
  installed: false,
  downloadedBytes: 0,
  downloading: true,
  error: null,
};

describe('saveRouteSettings', () => {
  test('saves the interpreter settings with one PUT and returns what the server kept', async () => {
    respond = (request) => reply(request.body);
    expect(await saveRouteSettings(settings)).toEqual(settings);
    expect(sent[0]).toMatchObject({ url: '/api/model-routes/settings', method: 'PUT' });
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual(settings);
  });
});

describe('local model download', () => {
  test('starts the download with a POST and reads back the status it answers with', async () => {
    respond = () => reply(JSON.stringify(localModel));
    expect(await downloadLocalModel()).toEqual(localModel);
    expect(sent[0]).toMatchObject({ url: '/api/model-routes/local/download', method: 'POST' });
  });

  test('surfaces the reason a download was refused', async () => {
    respond = () => reply(JSON.stringify({ error: 'No checksum is pinned for the local model in this build, so it cannot be downloaded safely' }), 409);
    await expect(downloadLocalModel()).rejects.toThrow(/No checksum is pinned/);
  });

  test('reads the status with a GET', async () => {
    respond = () => reply(JSON.stringify({ ...localModel, downloading: false, installed: true, downloadedBytes: localModel.bytes }));
    expect(await fetchLocalModel()).toMatchObject({ installed: true, downloading: false });
    expect(sent[0]).toMatchObject({ url: '/api/model-routes/local', method: 'GET' });
  });
});
