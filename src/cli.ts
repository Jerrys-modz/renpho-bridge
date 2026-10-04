#!/usr/bin/env node
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

const renpho = new RenphoClient(required('RENPHO_EMAIL'), required('RENPHO_PASSWORD'));
const sparky = new SparkyClient(required('SPARKY_URL'), required('SPARKY_API_KEY'));

const intervalMinutes = Number(process.env.SYNC_INTERVAL_MINUTES ?? 0);
const dryRun = args.has('--dry-run');

async function once(): Promise<boolean> {
  const result = await runSync(renpho, sparky, {
    includeTape: !args.has('--scale-only'),
    includeScale: !args.has('--tape-only'),
    dryRun,
    statePath: process.env.STATE_PATH ?? 'state.json',
    since: sinceArg,
  });
  console.log(
    `${new Date().toISOString()} ${result.records} new RENPHO record(s) -> ${result.entries} entr${result.entries === 1 ? 'y' : 'ies'}` +
      (dryRun ? ' (dry run, nothing sent)' : `, ${result.sent} accepted`)
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
