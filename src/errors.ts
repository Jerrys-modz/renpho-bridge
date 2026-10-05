/** A non-2xx answer from RENPHO or SparkyFitness. */
export class HttpError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    detail = ''
  ) {
    super(`${service} returned HTTP ${status}${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Whether trying again later could help: network failures, timeouts, and server-side/rate-limit HTTP errors.
 * Anything else (bad credentials, rejected entries, config mistakes) won't fix itself, and repeating a failed
 * RENPHO login risks locking the account, so those are not retried.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500 || err.status === 408 || err.status === 429;
  if (err instanceof Error) {
    // undici's "fetch failed" is a TypeError; timeouts from AbortSignal.timeout are TimeoutError.
    if (err instanceof TypeError || err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  }
  return false;
}
