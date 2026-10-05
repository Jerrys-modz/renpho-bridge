import { isRetryable } from './errors.js';

export interface RetryOptions {
  /** Total tries including the first (default 3). */
  attempts?: number;
  /** Delay before the second try; it grows 4x each time (default 30s, so 30s then 2min). */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = opts.baseDelayMs ?? 30_000;
  const sleep = opts.sleep ?? wait;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err;
      const delay = base * 4 ** (attempt - 1);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}
