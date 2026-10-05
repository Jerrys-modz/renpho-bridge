import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HttpError, isRetryable } from '../src/errors.js';
import { createMonitor, isHealthy, readStatus } from '../src/monitor.js';
import { RenphoApiError } from '../src/renphoClient.js';
import { withRetry } from '../src/retry.js';

describe('isRetryable', () => {
  it('retries network errors, timeouts, 5xx, 408 and 429', () => {
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryable(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    for (const status of [500, 502, 503, 408, 429]) expect(isRetryable(new HttpError('x', status))).toBe(true);
  });
  it('does not retry client errors, rejected logins or unknown errors', () => {
    expect(isRetryable(new HttpError('x', 401))).toBe(false);
    expect(isRetryable(new HttpError('x', 400))).toBe(false);
    expect(isRetryable(new RenphoApiError('Login', 106, 'user does not exist'))).toBe(false);
    expect(isRetryable(new Error('boom'))).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries transient failures with growing delays and then succeeds', async () => {
    const delays: number[] = [];
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new HttpError('RENPHO', 503);
        return 'ok';
      },
      { attempts: 3, baseDelayMs: 10, sleep: async (ms) => void delays.push(ms) }
    );
    expect(out).toBe('ok');
    expect(delays).toEqual([10, 40]);
  });

  it('gives up after the last attempt and throws the last error', async () => {
    const fn = vi.fn(async () => {
      throw new HttpError('RENPHO', 500);
    });
    await expect(withRetry(fn, { attempts: 2, sleep: async () => undefined })).rejects.toThrow(/HTTP 500/);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry errors that will not fix themselves', async () => {
    const fn = vi.fn(async () => {
      throw new RenphoApiError('Login', 106, 'bad');
    });
    await expect(withRetry(fn, { attempts: 5, sleep: async () => undefined })).rejects.toThrow(/Login failed/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('monitor', () => {
  const setup = async () => {
    const statusPath = join(await mkdtemp(join(tmpdir(), 'rp-')), 'status.json');
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    return { statusPath, calls, fetchFn };
  };

  it('pings success, records it, and stays quiet when nothing is configured to alert', async () => {
    const { statusPath, calls, fetchFn } = await setup();
    const m = createMonitor({ statusPath, healthcheckUrl: 'https://hc.example/abc', fetchFn });
    await m.success();
    expect(calls.map((c) => c.url)).toEqual(['https://hc.example/abc']);
    expect((await readStatus(statusPath))?.lastSuccess).toBeTruthy();
  });

  it('alerts once per outage, pings /fail every time, and announces recovery once', async () => {
    const { statusPath, calls, fetchFn } = await setup();
    const m = createMonitor({ statusPath, healthcheckUrl: 'https://hc.example/abc/', notifyUrl: 'https://ntfy.example/t', fetchFn });
    await m.failure(new Error('RENPHO down'));
    await m.failure(new Error('RENPHO still down'));
    const alerts = calls.filter((c) => c.url === 'https://ntfy.example/t');
    expect(alerts).toHaveLength(1);
    expect((alerts[0]?.init?.headers as Record<string, string>).Title).toBe('RENPHO sync failed');
    expect(calls.filter((c) => c.url === 'https://hc.example/abc/fail')).toHaveLength(2);
    expect((await readStatus(statusPath))?.consecutiveFailures).toBe(2);

    await m.success();
    const all = calls.filter((c) => c.url === 'https://ntfy.example/t');
    expect(all).toHaveLength(2);
    expect((all[1]?.init?.headers as Record<string, string>).Title).toBe('RENPHO sync recovered');
    await m.success();
    expect(calls.filter((c) => c.url === 'https://ntfy.example/t')).toHaveLength(2);
  });

  it('never throws when the alert endpoint is down or the status file is unwritable', async () => {
    const fetchFn = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The parent of this path is a regular file, so every write fails with ENOTDIR.
    const file = join(await mkdtemp(join(tmpdir(), 'rp-')), 'plain-file');
    await writeFile(file, 'x');
    const m = createMonitor({ statusPath: join(file, 'status.json'), notifyUrl: 'https://x', healthcheckUrl: 'https://y', fetchFn });
    await expect(m.failure(new Error('x'))).resolves.toBeUndefined();
    await expect(m.success()).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  it('writes a status file the healthcheck can read', async () => {
    const { statusPath, fetchFn } = await setup();
    await createMonitor({ statusPath, fetchFn }).success();
    expect(JSON.parse(await readFile(statusPath, 'utf8'))).toMatchObject({ consecutiveFailures: 0 });
  });
});

describe('isHealthy', () => {
  const at = new Date('2026-01-01T12:00:00Z');
  const ago = (min: number) => new Date(at.getTime() - min * 60_000).toISOString();
  it('is healthy within two intervals plus grace of the last success', () => {
    expect(isHealthy({ startedAt: ago(500), lastSuccess: ago(100), consecutiveFailures: 0, alerted: false }, 60, at)).toBe(true);
    expect(isHealthy({ startedAt: ago(500), lastSuccess: ago(200), consecutiveFailures: 0, alerted: false }, 60, at)).toBe(false);
  });
  it('gives a fresh container time before its first success, then fails it', () => {
    expect(isHealthy({ startedAt: ago(10), consecutiveFailures: 0, alerted: false }, 60, at)).toBe(true);
    expect(isHealthy({ startedAt: ago(400), consecutiveFailures: 3, alerted: true }, 60, at)).toBe(false);
  });
  it('is unhealthy with no status, and always healthy in one-shot mode', () => {
    expect(isHealthy(null, 60, at)).toBe(false);
    expect(isHealthy(null, 0, at)).toBe(true);
  });
});
