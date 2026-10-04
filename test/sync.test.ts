import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSync } from '../src/sync.js';

const NOW = new Date('2025-03-10T12:00:00Z');
const at = (iso: string) => Date.parse(iso) / 1000;
// waist readings: 8 days ago, 2 days ago, today
const records = [
  { timeStamp: at('2025-03-02T12:00:00Z'), timeZone: '0', waistValue: 82, waistUnit: 0 },
  { timeStamp: at('2025-03-08T12:00:00Z'), timeZone: '0', waistValue: 81, waistUnit: 0 },
  { timeStamp: at('2025-03-10T08:00:00Z'), timeZone: '0', waistValue: 80, waistUnit: 0 },
];
const mkRenpho = () => ({ getGirthMeasurements: async () => records, getScaleMeasurements: async () => [] });
const mkSend = () => vi.fn(async (e: unknown[]) => ({ sent: e.length, errors: [] as unknown[] }));
const tmpState = async () => join(await mkdtemp(join(tmpdir(), 'rp-')), 'state.json');
const base = { includeScale: true, includeTape: true, dryRun: false, now: NOW };

describe('runSync', () => {
  it('first run sends full history, later runs only the last N days', async () => {
    const statePath = await tmpState();
    const send = mkSend();
    const first = await runSync(mkRenpho(), { send }, { ...base, statePath });
    expect(first).toMatchObject({ mode: 'full', entries: 3, sent: 3 });
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ initialSyncDone: true });

    const second = await runSync(mkRenpho(), { send }, { ...base, statePath, syncDays: 3 });
    expect(second).toMatchObject({ mode: 'window', cutoff: '2025-03-07', entries: 2, skipped: 1 });
    // re-sent every run: the window is not de-duplicated locally
    const third = await runSync(mkRenpho(), { send }, { ...base, statePath, syncDays: 3 });
    expect(third.entries).toBe(2);
  });

  it('defaults to a 3 day window and honours a wider one', async () => {
    const statePath = await tmpState();
    await writeFile(statePath, JSON.stringify({ initialSyncDone: true }));
    const narrow = await runSync(mkRenpho(), { send: mkSend() }, { ...base, statePath });
    expect(narrow.cutoff).toBe('2025-03-07');
    const wide = await runSync(mkRenpho(), { send: mkSend() }, { ...base, statePath, syncDays: 30 });
    expect(wide.entries).toBe(3);
  });

  it('fullSync forces the whole history again; since limits it', async () => {
    const statePath = await tmpState();
    await writeFile(statePath, JSON.stringify({ initialSyncDone: true }));
    const full = await runSync(mkRenpho(), { send: mkSend() }, { ...base, statePath, fullSync: true });
    expect(full).toMatchObject({ mode: 'full', entries: 3 });
    const since = await runSync(mkRenpho(), { send: mkSend() }, { ...base, statePath, fullSync: true, since: '2025-03-08' });
    expect(since.entries).toBe(2);
  });

  it('keeps retrying the initial sync until everything is accepted', async () => {
    const statePath = await tmpState();
    const send = vi.fn(async () => ({ sent: 0, errors: [{ error: 'x' }] }));
    await runSync(mkRenpho(), { send }, { ...base, statePath });
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();
  });

  it('test mode returns pending entries, sends nothing and saves nothing', async () => {
    const statePath = await tmpState();
    const send = mkSend();
    const r = await runSync(mkRenpho(), { send }, { ...base, statePath, dryRun: true });
    expect(send).not.toHaveBeenCalled();
    expect(r.pending).toHaveLength(3);
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();
  });

  it('accepts the earlier id-list state file as a completed first sync', async () => {
    const statePath = await tmpState();
    await writeFile(statePath, JSON.stringify(['girth:7']));
    const r = await runSync(mkRenpho(), { send: mkSend() }, { ...base, statePath });
    expect(r.mode).toBe('window');
  });
});
