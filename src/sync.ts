import { readFile, writeFile } from 'node:fs/promises';
import { mapGirthRecord, mapScaleRecord, type HealthEntry, type LengthUnit } from './mapping.js';
import type { RenphoClient, RenphoRecord } from './renphoClient.js';
import type { SparkyClient } from './sparkyClient.js';

export interface SyncOptions {
  includeScale: boolean;
  includeTape: boolean;
  /** Restrict the scale sync to these scale table names (see `--list-devices`); empty or unset means all. */
  scaleTables?: string[];
  statePath: string;
  dryRun: boolean;
  /** Days of recent data re-sent on every run after the initial full sync (default 3). */
  syncDays?: number;
  /** Ignore saved state and send the full history again. */
  fullSync?: boolean;
  /** Only records on/after this YYYY-MM-DD are sent (also limits the initial full sync). */
  since?: string;
  /** Unit for custom-measurement tape sites (default cm). */
  lengthUnit?: LengthUnit;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface SyncResult {
  mode: 'full' | 'window';
  /** Earliest day (YYYY-MM-DD) included, if any. */
  cutoff?: string;
  fetched: { tape: number; scale: number };
  /** Fetched records that produced nothing (no usable timestamp, no values, or outside the window). */
  skipped: number;
  entries: number;
  sent: number;
  errors: unknown[];
  pending: HealthEntry[];
}

interface State {
  initialSyncDone: boolean;
  lastSync?: string;
}

async function loadState(path: string): Promise<State> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    // An array is the earlier id-list format, which also implies a completed first sync.
    if (Array.isArray(raw)) return { initialSyncDone: true };
    if (raw && typeof raw === 'object' && (raw as State).initialSyncDone === true) return raw as State;
  } catch {
    // missing or unreadable state means the initial sync hasn't happened
  }
  return { initialSyncDone: false };
}

export function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Like the mobile app: the first run sends all history once; every run after that re-sends only the last
 * `syncDays` days. Re-sending is safe because SparkyFitness upserts check-in fields and custom measurements
 * by day, so it picks up edits and late-arriving records without duplicating.
 */
export async function runSync(
  renpho: Pick<RenphoClient, 'getGirthMeasurements' | 'getScaleMeasurements'>,
  sparky: Pick<SparkyClient, 'send'>,
  opts: SyncOptions
): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const state = await loadState(opts.statePath);
  const full = opts.fullSync === true || !state.initialSyncDone;
  const windowStart = full ? undefined : daysAgo(now, opts.syncDays ?? 3);
  const cutoff = [windowStart, opts.since].filter((d): d is string => !!d).sort().pop();

  const entries: HealthEntry[] = [];
  const fetched = { tape: 0, scale: 0 };
  let skipped = 0;

  const collect = (kind: 'tape' | 'scale', records: RenphoRecord[], map: (r: RenphoRecord) => HealthEntry[]) => {
    fetched[kind] += records.length;
    for (const rec of records) {
      const mapped = map(rec).filter((e) => !cutoff || e.date >= cutoff);
      if (mapped.length === 0) skipped++;
      entries.push(...mapped);
    }
  };

  if (opts.includeTape) collect('tape', await renpho.getGirthMeasurements(), (r) => mapGirthRecord(r, opts.lengthUnit));
  if (opts.includeScale) collect('scale', await renpho.getScaleMeasurements(undefined, opts.scaleTables), mapScaleRecord);

  const base = { mode: full ? ('full' as const) : ('window' as const), cutoff, fetched, skipped, entries: entries.length };
  if (opts.dryRun) return { ...base, sent: 0, errors: [], pending: entries };

  const { sent, errors } = entries.length > 0 ? await sparky.send(entries) : { sent: 0, errors: [] };
  // The initial sync only counts as done once everything was accepted; otherwise the next run retries it.
  if (full && errors.length === 0) {
    await writeFile(opts.statePath, JSON.stringify({ initialSyncDone: true, lastSync: now.toISOString() }, null, 2));
  }
  return { ...base, sent, errors, pending: [] };
}
