import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSync } from '../src/sync.js';

const rec = { id: 7, timeStamp: 1740830400, timeZone: '0', waistValue: 80, waistUnit: 0 };
const mkRenpho = () => ({ getGirthMeasurements: async () => [rec], getScaleMeasurements: async () => [] });

describe('runSync', () => {
  it('sends new records once and remembers them', async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), 'rp-')), 'state.json');
    const send = vi.fn(async (e: unknown[]) => ({ sent: e.length, errors: [] }));
    const opts = { includeScale: true, includeTape: true, statePath, dryRun: false };
    const first = await runSync(mkRenpho(), { send }, opts);
    expect(first).toMatchObject({ records: 1, entries: 1, sent: 1 });
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual(['girth:7']);
    const second = await runSync(mkRenpho(), { send }, opts);
    expect(second.entries).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not record state on dry run or on rejected entries', async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), 'rp-')), 'state.json');
    const send = vi.fn(async () => ({ sent: 0, errors: [{ error: 'x' }] }));
    await runSync(mkRenpho(), { send }, { includeScale: false, includeTape: true, statePath, dryRun: true });
    expect(send).not.toHaveBeenCalled();
    await runSync(mkRenpho(), { send }, { includeScale: false, includeTape: true, statePath, dryRun: false });
    await expect(readFile(statePath, 'utf8')).rejects.toThrow();
  });
});
