import { fetchWithDeadline } from '../shared/bounded-fetch.js';
import { isString } from './validation.js';

export class GitLabRequestError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export function classifyGitLabFailure(error) {
  if (error instanceof GitLabRequestError) return error.kind;
  const code = isString(error?.code) ? error.code : '';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'ECONNREFUSED'
    || code === 'ECONNRESET' || code === 'EAI_AGAIN' || code.startsWith('ERR_TLS')) return 'unreachable';
  return 'provider-error';
}

export async function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs = 10_000) {
  // Delegates to the shared deadline (design #802 phase 2, #804), keeping
  // this name and signature for its importers. Two behaviour changes are
  // the design's intended contract: the caller's signal (init.signal)
  // composes with the deadline instead of being overwritten by it, and the
  // deadline stays armed until the response body has been read instead of
  // clearing when the headers arrive.
  return fetchWithDeadline(fetchImpl, url, { ...init, redirect: 'error' }, { timeoutMs, signal: init?.signal });
}
