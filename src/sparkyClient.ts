import type { HealthEntry } from './mapping.js';

export interface IngestResult {
  processed?: unknown[];
  errors?: unknown[];
  skipped?: unknown[];
}

/** Thin client for SparkyFitness `POST /api/health-data` (API-key authenticated). */
export class SparkyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  async send(entries: HealthEntry[], batchSize = 200): Promise<{ sent: number; errors: unknown[] }> {
    const errors: unknown[] = [];
    let sent = 0;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const res = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, '')}/api/health-data`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error(`SparkyFitness returned HTTP ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as IngestResult;
      errors.push(...(body.errors ?? []));
      sent += batch.length - (body.errors?.length ?? 0);
    }
    return { sent, errors };
  }
}
