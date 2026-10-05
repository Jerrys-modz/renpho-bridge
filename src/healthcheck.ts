#!/usr/bin/env node
// Docker HEALTHCHECK: exits 1 when the sync hasn't succeeded recently.
import { dirname, join } from 'node:path';
import { isHealthy, readStatus } from './monitor.js';

const statusPath = process.env.STATUS_PATH ?? join(dirname(process.env.STATE_PATH ?? 'state.json'), 'status.json');
const interval = Number(process.env.SYNC_INTERVAL_MINUTES ?? 0);
const status = await readStatus(statusPath);
const healthy = isHealthy(status, interval, new Date());
if (!healthy) console.error(`unhealthy: last success ${status?.lastSuccess ?? 'never'}, last error ${status?.lastError ?? 'none'}`);
process.exit(healthy ? 0 : 1);
