#!/usr/bin/env node
import type { LengthUnit } from './mapping.js';
import { dirname, join } from 'node:path';
import { fileSessionStore } from './sessionStore.js';
import { RenphoClient } from './renphoClient.js';
import { SparkyClient } from './sparkyClient.js';
import { runSync } from './sync.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name} (see README).`);
    process.exit(2);
  }
  return v;
}

const args = new Set(process.argv.slice(2));
const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.slice(8);

// Test mode: read from RENPHO and print what would be sent; never contacts SparkyFitness or writes state.
const dryRun = args.has('--dry-run') || args.has('--test') || ['1', 'true', 'yes'].includes((process.env.TEST_MODE ?? '').toLowerCase());

const debugOn = args.has('--debug') || ['1', 'true', 'yes'].includes((process.env.DEBUG ?? '').toLowerCase());
const renpho = new RenphoClient(
  required('RENPHO_EMAIL'),
  required('RENPHO_PASSWORD'),
  fetch,
  debugOn,
  fileSessionStore(process.env.SESSION_PATH ?? join(dirname(process.env.STATE_PATH ?? 'state.json'), 'session.json'))
);
console.log(
  `renpho-bridge build ${(process.env.GIT_SHA ?? 'dev').slice(0, 7)} | test mode: ${dryRun ? 'on' : 'off'} | debug: ${debugOn ? 'on' : 'off'}`
);
const sparky = dryRun
  ? new SparkyClient('', '')
  : new SparkyClient(required('SPARKY_URL'), required('SPARKY_API_KEY'));

const syncDays = Number(process.env.SYNC_DAYS ?? 3);
if (!Number.isInteger(syncDays) || syncDays < 1) {
  console.error('SYNC_DAYS must be a whole number of days, 1 or more.');
  process.exit(2);
}
const fullSync = args.has('--full') || ['1', 'true', 'yes'].includes((process.env.FULL_SYNC ?? '').toLowerCase());
const intervalMinutes = Number(process.env.SYNC_INTERVAL_MINUTES ?? 0);
const rawUnit = (process.env.LENGTH_UNIT ?? 'cm').toLowerCase();
if (rawUnit !== 'cm' && rawUnit !== 'in') {
  console.error('LENGTH_UNIT must be "cm" or "in".');
  process.exit(2);
}
const lengthUnit: LengthUnit = rawUnit;

async function once(): Promise<boolean> {
  const result = await runSync(renpho, sparky, {
    includeTape: !args.has('--scale-only'),
    includeScale: !args.has('--tape-only'),
    dryRun,
    statePath: process.env.STATE_PATH ?? 'state.json',
    since: sinceArg ?? process.env.SINCE_DATE,
    syncDays,
    fullSync,
    lengthUnit,
  });
  if (dryRun) {
    console.log('[TEST MODE] Nothing is sent to SparkyFitness and no state is saved. Entries that would be sent:');
    for (const e of result.pending) {
      console.log(`  ${e.date}  ${e.type.padEnd(22)} ${String(e.value).padStart(8)} ${e.unit ?? ''}  (${e.timestamp})`);
    }
  }
  const stamp = new Date().toISOString();
  console.log(
    `${stamp} ${result.mode === 'full' ? 'initial full sync' : `last ${syncDays} days`}` +
      `${result.cutoff ? ` (from ${result.cutoff})` : ''}: RENPHO returned ${result.fetched.tape} tape and ` +
      `${result.fetched.scale} scale record(s), ${result.skipped} had nothing to send -> ${result.entries} entr${result.entries === 1 ? 'y' : 'ies'}` +
      (dryRun ? ' (test mode, nothing sent)' : `, ${result.sent} accepted`)
  );
  if (result.errors.length > 0) {
    console.error('SparkyFitness rejected some entries:', JSON.stringify(result.errors, null, 2));
    return false;
  }
  return true;
}

if (intervalMinutes > 0) {
  // Long-running mode (Docker): a failed run is logged and retried on the next tick.
  for (;;) {
    try {
      await once();
    } catch (err) {
      console.error(`${new Date().toISOString()} sync failed:`, err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, intervalMinutes * 60_000));
  }
} else {
  try {
    if (!(await once())) process.exit(1);
  } catch (err) {
    console.error('sync failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
