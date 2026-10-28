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
/** Include the undici/Node cause, which `fetch failed` otherwise hides. */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (value == null || seen.has(value)) return;
    if (typeof value !== 'object') {
      parts.push(String(value));
      return;
    }
    seen.add(value);
    if (value instanceof AggregateError) {
      parts.push(value.message);
      for (const inner of value.errors) walk(inner);
      return;
    }
    if (value instanceof Error) {
      const extra = value as NodeJS.ErrnoException & { hostname?: string };
      const detail = [extra.code, extra.syscall, extra.hostname].filter(Boolean).join(' ');
      parts.push(detail ? `${value.message} (${detail})` : value.message);
      walk(value.cause);
    }
  };
  walk(err);
  return parts.join(' -> ') || String(err);
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500 || err.status === 408 || err.status === 429;
  if (err instanceof Error) {
    // undici's "fetch failed" is a TypeError; timeouts from AbortSignal.timeout are TimeoutError.
    if (err instanceof TypeError || err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  }
  return false;
}
