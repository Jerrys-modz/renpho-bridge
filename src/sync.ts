import { readFile, writeFile } from 'node:fs/promises';
import { mapGirthRecord, mapScaleRecord, recordId, type HealthEntry } from './mapping.js';
import type { RenphoClient, RenphoRecord } from './renphoClient.js';
import type { SparkyClient } from './sparkyClient.js';

export interface SyncOptions {
  includeScale: boolean;
  includeTape: boolean;
  statePath: string;
  dryRun: boolean;
  /** Only records on/after this YYYY-MM-DD are synced. */
  since?: string;
}

async function loadState(path: string): Promise<Set<string>> {
  try {
    return new Set(JSON.parse(await readFile(path, 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}

export async function runSync(
  renpho: Pick<RenphoClient, 'getGirthMeasurements' | 'getScaleMeasurements'>,
  sparky: Pick<SparkyClient, 'send'>,
  opts: SyncOptions
): Promise<{ records: number; entries: number; sent: number; errors: unknown[] }> {
  const seen = await loadState(opts.statePath);
  const fresh: { id: string; entries: HealthEntry[] }[] = [];

  const collect = (kind: 'girth' | 'scale', records: RenphoRecord[], map: (r: RenphoRecord) => HealthEntry[]) => {
    for (const rec of records) {
      const id = recordId(kind, rec);
      if (!id || seen.has(id)) continue;
      const entries = map(rec).filter((e) => !opts.since || e.date >= opts.since);
      if (entries.length > 0) fresh.push({ id, entries });
    }
  };

  if (opts.includeTape) collect('girth', await renpho.getGirthMeasurements(), mapGirthRecord);
  if (opts.includeScale) collect('scale', await renpho.getScaleMeasurements(), mapScaleRecord);

  const entries = fresh.flatMap((f) => f.entries);
  if (opts.dryRun || entries.length === 0) {
    return { records: fresh.length, entries: entries.length, sent: 0, errors: [] };
  }

  const { sent, errors } = await sparky.send(entries);
  // Only mark records done when the whole batch went through; failed ones retry next run.
  if (errors.length === 0) {
    for (const f of fresh) seen.add(f.id);
    await writeFile(opts.statePath, JSON.stringify([...seen], null, 2));
  }
  return { records: fresh.length, entries: entries.length, sent, errors };
}
