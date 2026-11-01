export const API_PROXY_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

export class ResponseBodyTooLargeError extends Error {
  constructor() {
    super('OpenCode API response exceeded the 16 MiB limit');
    this.name = 'ResponseBodyTooLargeError';
  }
}

const cancelBody = (body: ReadableStream<Uint8Array> | null): void => {
  if (!body) return;
  try {
    void body.cancel().catch(() => {});
  } catch {
    // Cancellation is best-effort when the upstream has already disturbed its body.
  }
};

export const readBoundedResponseBody = async (response: Response): Promise<Uint8Array> => {
  const declaredLength = response.headers.get('content-length')?.trim();
  const declaredByteLength = declaredLength && /^\d+$/.test(declaredLength) ? Number(declaredLength) : null;
  if (declaredByteLength !== null && declaredByteLength > API_PROXY_RESPONSE_MAX_BYTES) {
    cancelBody(response.body);
    throw new ResponseBodyTooLargeError();
  }

  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  let body = declaredByteLength === null ? new Uint8Array() : new Uint8Array(declaredByteLength);
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const requiredBytes = totalBytes + value.byteLength;
      if (requiredBytes > API_PROXY_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new ResponseBodyTooLargeError();
      }
      if (requiredBytes > body.byteLength) {
        const capacity = Math.min(
          API_PROXY_RESPONSE_MAX_BYTES,
          Math.max(requiredBytes, body.byteLength === 0 ? 64 * 1024 : body.byteLength * 2),
        );
        const expanded = new Uint8Array(capacity);
        expanded.set(body.subarray(0, totalBytes));
        body = expanded;
      }
      body.set(value, totalBytes);
      totalBytes = requiredBytes;
    }
  } finally {
    reader.releaseLock();
  }

  return body.subarray(0, totalBytes);
};
