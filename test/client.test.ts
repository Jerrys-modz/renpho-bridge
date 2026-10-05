import { describe, expect, it, vi } from 'vitest';
import { aesDecrypt, aesEncrypt } from '../src/crypto.js';
import { extractRecords, RenphoClient } from '../src/renphoClient.js';

const ok = (data: unknown) => ({ code: 101, msg: 'success', data: aesEncrypt(JSON.stringify(data)) });

/** Fake RENPHO cloud keyed by endpoint path; records the decrypted request bodies. */
function fakeCloud(routes: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchFn = (async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname.slice(1);
    const enc = (JSON.parse(init.body) as { encryptData: string }).encryptData;
    const text = aesDecrypt(enc);
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    calls.push({ path, body });
    const handler = routes[path];
    const out = handler?.(body); // undefined means the server answered HTTP 400
    return { ok: out !== undefined, status: out !== undefined ? 200 : 400, json: async () => out };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const login = () => ok({ login: { token: 'tok', id: 1234567 } });

describe('RenphoClient.getScaleMeasurements', () => {
  it('uses the table and user id from device info, not a guessed shard', async () => {
    const { fetchFn, calls } = fakeCloud({
      'renpho-aggregation/user/login': login,
      'renpho-aggregation/device/count': () => ok({ scale: [{ tableName: 'measurements_info_7', count: 0, userIds: ['999'] }] }),
      'RenphoHealth/scale/queryBodyCompositionMeasureData': (b) =>
        ok(b.pageNum === 1 ? [{ id: 1, timeStamp: 1740830400, weight: 80 }] : []),
    });
    const records = await new RenphoClient('a', 'b', fetchFn).getScaleMeasurements();
    expect(records).toHaveLength(1);
    const read = calls.find((c) => c.path.endsWith('queryBodyCompositionMeasureData'));
    expect(read?.body).toMatchObject({ tableName: 'measurements_info_7', userIds: ['999'] });
  });

  it('falls back to the legacy endpoint when body composition is empty', async () => {
    const { fetchFn } = fakeCloud({
      'renpho-aggregation/user/login': login,
      'renpho-aggregation/device/count': () => ok({ scale: [{ tableName: 't', count: 5, userIds: ['1234567'] }] }),
      'RenphoHealth/scale/queryBodyCompositionMeasureData': () => ok([]),
      'RenphoHealth/scale/queryAllMeasureDataList': (b) => ok(b.pageNum === 1 ? [{ id: 9, timeStamp: 1, weight: 70 }] : []),
    });
    expect(await new RenphoClient('a', 'b', fetchFn).getScaleMeasurements()).toHaveLength(1);
  });

  it('retries device info with an empty object when the empty-bytes body is rejected', async () => {
    let attempt = 0;
    const { fetchFn } = fakeCloud({
      'renpho-aggregation/user/login': login,
      'renpho-aggregation/device/count': () => {
        attempt++;
        return attempt === 1 ? undefined : ok({ scale: [] });
      },
    });
    await expect(new RenphoClient('a', 'b', fetchFn).getScaleMeasurements()).resolves.toEqual([]);
  });
});

describe('extractRecords', () => {
  it('handles list wrappers and a single bare record', () => {
    expect(extractRecords({ measurements: [{ a: 1 }] })).toHaveLength(1);
    expect(extractRecords({ list: [{ a: 1 }, { a: 2 }] })).toHaveLength(2);
    expect(extractRecords({ weight: 80 })).toEqual([{ weight: 80 }]);
    expect(extractRecords(null)).toEqual([]);
  });
});

describe('large integer ids', () => {
  it('keeps 19-digit user ids exact and does not touch strings or small numbers', async () => {
    const { parseJsonKeepingBigInts } = await import('../src/crypto.js');
    const out = parseJsonKeepingBigInts<Record<string, unknown>>(
      '{"id":1616785610291582123,"note":"x 1616785610291582123 y","ts":1740830400,"w":80.25,"ids":[1616785610291582124]}'
    );
    expect(out).toEqual({ id: '1616785610291582123', note: 'x 1616785610291582123 y', ts: 1740830400, w: 80.25, ids: ['1616785610291582124'] });
  });

  it('sends the exact user id to RENPHO', async () => {
    const seen: Record<string, unknown>[] = [];
    const { fetchFn } = fakeCloud({
      'renpho-aggregation/user/login': () => ({ code: 101, msg: 'success', data: aesEncrypt('{"login":{"token":"t","id":1616785610291582123}}') }),
      'renpho-aggregation/device/count': () => ok({ scale: [{ tableName: 't', count: 1, userIds: [] }] }),
      'RenphoHealth/scale/queryBodyCompositionMeasureData': (b) => {
        seen.push(b);
        return ok([]);
      },
      'RenphoHealth/scale/queryAllMeasureDataList': () => ok([]),
    });
    await new RenphoClient('a', 'b', fetchFn).getScaleMeasurements();
    expect(seen[0]?.userIds).toEqual(['1616785610291582123']);
  });
});

describe('session reuse', () => {
  const memStore = (initial: { token: string; userId: string; loginAt?: string } | null) => {
    let saved = initial;
    return { load: async () => saved, save: async (s: typeof saved) => void (saved = s), get: () => saved };
  };
  const scaleRoutes = (counter: { logins: number }) => ({
    'renpho-aggregation/user/login': () => {
      counter.logins++;
      return ok({ login: { token: `tok${counter.logins}`, id: 42 } });
    },
    'renpho-aggregation/device/count': () => ok({ scale: [{ tableName: 't', count: 1, userIds: [] }] }),
    'RenphoHealth/scale/queryBodyCompositionMeasureData': (_b: Record<string, unknown>) => ok([{ id: 1, timeStamp: 1, weight: 70 }]),
    'RenphoHealth/scale/queryAllMeasureDataList': () => ok([]),
  });

  it('does not log in when a saved session exists and works', async () => {
    const counter = { logins: 0 };
    const store = memStore({ token: 'saved', userId: '42', loginAt: new Date().toISOString() });
    const { fetchFn } = fakeCloud(scaleRoutes(counter));
    const records = await new RenphoClient('a', 'b', fetchFn, false, store).getScaleMeasurements();
    expect(records).toHaveLength(1);
    expect(counter.logins).toBe(0);
  });

  it('logs in and saves the token when there is no saved session', async () => {
    const counter = { logins: 0 };
    const store = memStore(null);
    const { fetchFn } = fakeCloud(scaleRoutes(counter));
    await new RenphoClient('a', 'b', fetchFn, false, store).getScaleMeasurements();
    expect(counter.logins).toBe(1);
    expect(store.get()).toMatchObject({ token: 'tok1', userId: '42' });
  });

  it('logs in again once when the saved session is rejected', async () => {
    const counter = { logins: 0 };
    const store = memStore({ token: 'stale', userId: '42', loginAt: new Date().toISOString() });
    const routes = scaleRoutes(counter);
    let first = true;
    routes['renpho-aggregation/device/count'] = () => {
      if (first) {
        first = false;
        return { code: 401, msg: 'token invalid' } as never; // API-level rejection
      }
      return ok({ scale: [{ tableName: 't', count: 1, userIds: [] }] });
    };
    const { fetchFn } = fakeCloud(routes);
    const records = await new RenphoClient('a', 'b', fetchFn, false, store).getScaleMeasurements();
    expect(records).toHaveLength(1);
    expect(counter.logins).toBe(1);
    expect(store.get()?.token).toBe('tok1');
  });

  it('an empty result with a fresh saved session does not trigger a login (e.g. no tape measure)', async () => {
    const counter = { logins: 0 };
    const store = memStore({ token: 'saved', userId: '42', loginAt: new Date().toISOString() });
    const { fetchFn } = fakeCloud({ ...scaleRoutes(counter), 'RenphoHealth/renpho/girth/queryAllGirthsDataList': () => ok([]) });
    expect(await new RenphoClient('a', 'b', fetchFn, false, store).getGirthMeasurements()).toEqual([]);
    expect(counter.logins).toBe(0);
  });

  it('an empty result from an old saved session is double-checked with one login', async () => {
    const counter = { logins: 0 };
    const store = memStore({ token: 'saved', userId: '42', loginAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    const { fetchFn } = fakeCloud({ ...scaleRoutes(counter), 'RenphoHealth/renpho/girth/queryAllGirthsDataList': () => ok([]) });
    await new RenphoClient('a', 'b', fetchFn, false, store).getGirthMeasurements();
    expect(counter.logins).toBe(1);
  });
});

describe('getTokenTime debug probe', () => {
  const routes = (seen: string[]) => ({
    'renpho-aggregation/user/login': login,
    'RenphoHealth/app/sync/getTokenTime': () => {
      seen.push('probe');
      return ok({ expireTime: 123, token: 'secret-token-value' });
    },
    'RenphoHealth/renpho/girth/queryAllGirthsDataList': () => ok([{ id: 1, timeStamp: 1, waistValue: 80 }]),
  });

  it('is skipped unless debug is on', async () => {
    const seen: string[] = [];
    const { fetchFn } = fakeCloud(routes(seen));
    await new RenphoClient('a', 'b', fetchFn, false).getGirthMeasurements();
    expect(seen).toEqual([]);
  });

  it('logs the answer with tokens redacted and never breaks the sync', async () => {
    const seen: string[] = [];
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(String(m)));
    const { fetchFn } = fakeCloud(routes(seen));
    const records = await new RenphoClient('a', 'b', fetchFn, true).getGirthMeasurements();
    spy.mockRestore();
    expect(records).toHaveLength(1);
    const line = logs.find((l) => l.includes('getTokenTime')) ?? '';
    expect(line).toContain('expireTime');
    expect(line).not.toContain('secret-token-value');
  });

  it('survives the endpoint failing', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { fetchFn } = fakeCloud({ ...routes([]), 'RenphoHealth/app/sync/getTokenTime': () => undefined as never });
    const records = await new RenphoClient('a', 'b', fetchFn, true).getGirthMeasurements();
    spy.mockRestore();
    expect(records).toHaveLength(1);
  });
});

describe('choosing devices', () => {
  const twoScales = (reads: string[]) => ({
    'renpho-aggregation/user/login': login,
    'renpho-aggregation/device/count': () =>
      ok({ scale: [{ tableName: 'measurements_info_1', count: 3, userIds: [] }, { tableName: 'measurements_info_2', count: 5, userIds: [] }] }),
    'RenphoHealth/scale/queryBodyCompositionMeasureData': (b: Record<string, unknown>) => {
      reads.push(String(b.tableName));
      return ok(b.pageNum === 1 ? [{ id: 1, timeStamp: 1, weight: 70 }] : []);
    },
    'RenphoHealth/renpho/girth/queryAllGirthsDataList': () => ok([{ id: 1, timeStamp: 1 }, { id: 2, timeStamp: 2 }]),
  });

  it('reads only the selected scale tables', async () => {
    const reads: string[] = [];
    const { fetchFn } = fakeCloud(twoScales(reads));
    await new RenphoClient('a', 'b', fetchFn).getScaleMeasurements(50, ['measurements_info_2']);
    expect(reads).toEqual(['measurements_info_2']);
  });

  it('reads every scale when none is selected', async () => {
    const reads: string[] = [];
    const { fetchFn } = fakeCloud(twoScales(reads));
    await new RenphoClient('a', 'b', fetchFn).getScaleMeasurements();
    expect(reads).toEqual(['measurements_info_1', 'measurements_info_2']);
  });

  it('explains an unmatched selection with the available tables', async () => {
    const { fetchFn } = fakeCloud(twoScales([]));
    await expect(new RenphoClient('a', 'b', fetchFn).getScaleMeasurements(50, ['nope'])).rejects.toThrow(
      /measurements_info_1, measurements_info_2/
    );
  });

  it('lists the devices on the account', async () => {
    const { fetchFn } = fakeCloud(twoScales([]));
    const out = await new RenphoClient('a', 'b', fetchFn).listDevices();
    expect(out.scales.map((s) => s.tableName)).toEqual(['measurements_info_1', 'measurements_info_2']);
    expect(out.tapeRecords).toBe(2);
  });
});
