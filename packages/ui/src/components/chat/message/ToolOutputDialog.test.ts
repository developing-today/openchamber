import { describe, expect, test } from 'bun:test';

import { MERMAID_REMOTE_LOAD_TIMEOUT_MS, MERMAID_REMOTE_MAX_BYTES, MermaidLoadFailure, getMermaidDataUrlSourcePromise, getMermaidRemoteSourcePromise, isCurrentMermaidLoadRequest, nextMermaidLoadRequestId, type MermaidRemoteLoadOptions } from './toolOutputDialogMermaid';

describe('getMermaidDataUrlSourcePromise', () => {
    test('turns malformed data URLs into rejected promises', async () => {
        const sourcePromise = getMermaidDataUrlSourcePromise('data:text/plain;base64');

        await sourcePromise.then(
            () => {
                throw new Error('expected malformed data URL to reject');
            },
            (error) => {
                expect(error).toBeInstanceOf(Error);
                expect(error).toBeInstanceOf(MermaidLoadFailure);
                expect(error.key).toBe('chat.toolOutputDialog.mermaid.dataUrlMalformed');
                expect(error.params).toBe(undefined);
            },
        );
    });
});

describe('Mermaid load request ids', () => {
    test('invalidates stale async loads when a newer load starts', () => {
        const firstRequest = nextMermaidLoadRequestId(0);
        const secondRequest = nextMermaidLoadRequestId(firstRequest);

        expect(isCurrentMermaidLoadRequest(secondRequest, firstRequest)).toBe(false);
        expect(isCurrentMermaidLoadRequest(secondRequest, secondRequest)).toBe(true);
    });
});

describe('getMermaidRemoteSourcePromise (#931)', () => {
    // SAFETY: the stub implements only the (url, init) surface the loader
    // calls; the loader never reads other fetch behaviour in these tests.
    const stubFetch = (handler: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch =>
        handler as typeof fetch;

    const streamingResponse = (chunks: Uint8Array[], status = 200): Response => new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(chunk);
                }
                controller.close();
            },
        }),
        { status },
    );

    test('the named deadline and byte cap are the defaults', () => {
        const options: MermaidRemoteLoadOptions = {};
        expect(options.timeoutMs ?? MERMAID_REMOTE_LOAD_TIMEOUT_MS).toBe(15_000);
        expect(options.maxBytes ?? MERMAID_REMOTE_MAX_BYTES).toBe(1024 * 1024);
    });

    test('a stalled server reaches the loadFailed error state at the deadline', async () => {
        const stalledFetch = stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }));

        const error = await getMermaidRemoteSourcePromise('https://diagrams.example/slow.mmd', { fetchImpl: stalledFetch, timeoutMs: 10 }).then(
            () => { throw new Error('expected stalled load to reject'); },
            (caught) => caught,
        );
        expect(error).toBeInstanceOf(MermaidLoadFailure);
        expect(error.key).toBe('chat.toolOutputDialog.mermaid.loadFailed');
    });

    test('an oversized body is rejected instead of buffered whole', async () => {
        const bigFetch = stubFetch(async () => streamingResponse([new TextEncoder().encode('graph TD; A-->B'), new TextEncoder().encode(' -->C')]));

        const error = await getMermaidRemoteSourcePromise('https://diagrams.example/big.mmd', { fetchImpl: bigFetch, maxBytes: 8 }).then(
            () => { throw new Error('expected oversized load to reject'); },
            (caught) => caught,
        );
        expect(error).toBeInstanceOf(MermaidLoadFailure);
        expect(error.key).toBe('chat.toolOutputDialog.mermaid.loadFailed');
    });

    test('a small body resolves and a non-ok status keeps its status failure', async () => {
        const okFetch = stubFetch(async () => streamingResponse([new TextEncoder().encode('graph TD; A-->B')]));
        const text = await getMermaidRemoteSourcePromise('https://diagrams.example/a.mmd', { fetchImpl: okFetch });
        expect(text).toBe('graph TD; A-->B');

        const failingFetch = stubFetch(async () => streamingResponse([], 503));
        const error = await getMermaidRemoteSourcePromise('https://diagrams.example/a.mmd', { fetchImpl: failingFetch }).then(
            () => { throw new Error('expected non-ok load to reject'); },
            (caught) => caught,
        );
        expect(error).toBeInstanceOf(MermaidLoadFailure);
        expect(error.key).toBe('chat.toolOutputDialog.mermaid.loadFailedWithStatus');
        expect(error.params).toEqual({ status: 503 });
    });
});
