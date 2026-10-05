import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Status {
  startedAt: string;
  lastSuccess?: string;
  lastFailure?: string;
  lastError?: string;
  consecutiveFailures: number;
  /** True once a failure alert has been sent, so recovery is announced exactly once. */
  alerted: boolean;
}

export async function readStatus(path: string): Promise<Status | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Status;
  } catch {
    return null;
  }
}

async function writeStatus(path: string, status: Status): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(status, null, 2));
}

export interface MonitorOptions {
  statusPath: string;
  /** healthchecks.io style: GET `<url>` on success and `<url>/fail` on failure. */
  healthcheckUrl?: string;
  /** ntfy style: POST the message as the body with a Title header. */
  notifyUrl?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

/** Records each run's outcome for the Docker healthcheck and sends optional pings and alerts. Never throws. */
export function createMonitor(opts: MonitorOptions) {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? (() => new Date());

  const call = async (url: string, init?: RequestInit): Promise<void> => {
    try {
      await fetchFn(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      console.error(`monitor call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const notify = (title: string, message: string) =>
    opts.notifyUrl ? call(opts.notifyUrl, { method: 'POST', headers: { Title: title }, body: message }) : Promise.resolve();

  const load = async (): Promise<Status> =>
    (await readStatus(opts.statusPath)) ?? { startedAt: now().toISOString(), consecutiveFailures: 0, alerted: false };

  return {
    async start(): Promise<void> {
      const status = await load();
      status.startedAt = now().toISOString();
      await writeStatus(opts.statusPath, status).catch(() => undefined);
    },

    async success(): Promise<void> {
      const status = await load();
      const recovered = status.alerted;
      Object.assign(status, { lastSuccess: now().toISOString(), consecutiveFailures: 0, alerted: false });
      delete status.lastError;
      await writeStatus(opts.statusPath, status).catch(() => undefined);
      if (opts.healthcheckUrl) await call(opts.healthcheckUrl);
      if (recovered) await notify('RENPHO sync recovered', 'The RENPHO to SparkyFitness sync is working again.');
    },

    async failure(error: unknown): Promise<void> {
      const message = error instanceof Error ? error.message : String(error);
      const status = await load();
      status.lastFailure = now().toISOString();
      status.lastError = message.slice(0, 500);
      status.consecutiveFailures += 1;
      const firstAlert = !status.alerted;
      status.alerted = true;
      await writeStatus(opts.statusPath, status).catch(() => undefined);
      if (opts.healthcheckUrl) await call(`${opts.healthcheckUrl.replace(/\/+$/, '')}/fail`, { method: 'POST', body: message.slice(0, 500) });
      // One alert per outage; the recovery message closes it.
      if (firstAlert) await notify('RENPHO sync failed', message.slice(0, 500));
    },
  };
}

/** Healthy when the last success is recent enough for the sync interval (or the container is still starting). */
export function isHealthy(status: Status | null, intervalMinutes: number, at: Date): boolean {
  if (intervalMinutes <= 0) return true; // one-shot mode has nothing to monitor
  if (!status) return false;
  const maxAgeMs = (intervalMinutes * 2 + 15) * 60_000;
  const reference = status.lastSuccess ?? status.startedAt;
  return at.getTime() - Date.parse(reference) <= maxAgeMs;
}
