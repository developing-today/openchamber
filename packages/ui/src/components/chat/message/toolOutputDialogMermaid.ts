import type { I18nKey, I18nParams } from '@/lib/i18n';

export class MermaidLoadFailure extends Error {
    key: I18nKey;
    params?: I18nParams;

    constructor(key: I18nKey, params?: I18nParams) {
        super(key);
        this.name = 'MermaidLoadFailure';
        this.key = key;
        this.params = params;
    }
}

const mermaidLoadFailure = (key: I18nKey, params?: I18nParams): MermaidLoadFailure => new MermaidLoadFailure(key, params);

export const isMermaidLoadFailure = (value: unknown): value is MermaidLoadFailure => value instanceof MermaidLoadFailure;

export const nextMermaidLoadRequestId = (current: number): number => current + 1;

export const isCurrentMermaidLoadRequest = (current: number, requestId: number): boolean => current === requestId;

const decodeMermaidDataUrl = (value: string): string => {
    const commaIndex = value.indexOf(',');
    if (commaIndex < 0) {
        throw mermaidLoadFailure('chat.toolOutputDialog.mermaid.dataUrlMalformed');
    }

    const metadata = value.slice(0, commaIndex).toLowerCase();
    const payload = value.slice(commaIndex + 1);
    if (metadata.includes(';base64')) {
        return atob(payload);
    }
    return decodeURIComponent(payload);
};

export const getMermaidDataUrlSourcePromise = (value: string): Promise<string> => Promise.resolve().then(() => decodeMermaidDataUrl(value));

// The remote-URL branch loads from a host named by tool output, not from the
// user's own server, so it gets the same treatment as the other remote loads
// (#851/#854/#855, McpxDashboard in #980): an explicit deadline plus a byte
// cap, instead of a bare fetch that can stall the dialog in `loading` forever
// or buffer an unbounded body into the renderer (#931).
export const MERMAID_REMOTE_LOAD_TIMEOUT_MS = 15_000;
export const MERMAID_REMOTE_MAX_BYTES = 1024 * 1024;

export interface MermaidRemoteLoadOptions {
    /** Caller lifecycle: aborting it (load superseded, dialog closed) aborts the request. */
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
}

const readMermaidBodyWithCap = async (response: Response, maxBytes: number, abort: () => void): Promise<string> => {
    if (!response.body) {
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > maxBytes) {
            throw mermaidLoadFailure('chat.toolOutputDialog.mermaid.loadFailed');
        }
        return text;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
                abort();
                throw mermaidLoadFailure('chat.toolOutputDialog.mermaid.loadFailed');
            }
            chunks.push(value);
        }
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
};

export const getMermaidRemoteSourcePromise = async (url: string, options: MermaidRemoteLoadOptions = {}): Promise<string> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? MERMAID_REMOTE_LOAD_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? MERMAID_REMOTE_MAX_BYTES;

    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (options.signal) {
        if (options.signal.aborted) {
            controller.abort();
        } else {
            options.signal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok) {
            throw mermaidLoadFailure('chat.toolOutputDialog.mermaid.loadFailedWithStatus', { status: response.status });
        }
        return await readMermaidBodyWithCap(response, maxBytes, () => controller.abort());
    } catch (error) {
        if (isMermaidLoadFailure(error)) {
            throw error;
        }
        // Deadline, caller abort, and network failure all land in the same
        // existing loadFailed error state; a superseded load's rejection is
        // discarded by the caller's request-id guard.
        throw mermaidLoadFailure('chat.toolOutputDialog.mermaid.loadFailed');
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onExternalAbort);
    }
};
