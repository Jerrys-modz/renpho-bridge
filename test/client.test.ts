import { describe, expect, it } from 'vitest';
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
