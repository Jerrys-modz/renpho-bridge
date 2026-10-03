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

const result = await runSync(renpho, sparky, {
  includeTape: !args.has('--scale-only'),
  includeScale: !args.has('--tape-only'),
  dryRun: args.has('--dry-run'),
  statePath: process.env.STATE_PATH ?? 'state.json',
  since: sinceArg,
});

console.log(
  `${result.records} new RENPHO record(s) -> ${result.entries} entr${result.entries === 1 ? 'y' : 'ies'}` +
    (args.has('--dry-run') ? ' (dry run, nothing sent)' : `, ${result.sent} accepted`)
);
if (result.errors.length > 0) {
  console.error('SparkyFitness rejected some entries:', JSON.stringify(result.errors, null, 2));
  process.exit(1);
}
