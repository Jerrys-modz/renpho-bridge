import { describe, expect, it } from 'vitest';
import { aesDecrypt, aesEncrypt } from '../src/crypto.js';
import { mapGirthRecord, mapScaleRecord, recordTime, tzOffsetSeconds } from '../src/mapping.js';

describe('crypto', () => {
  it('round-trips', () => {
    expect(aesDecrypt(aesEncrypt('{"a":1}'))).toBe('{"a":1}');
  });
});

describe('tzOffsetSeconds', () => {
  it.each([['-5:00', -18000], ['+5:30', 19800], ['-5', -18000], ['5.5', 19800], ['', 0], ['junk', 0]])('%s', (i, o) => {
    expect(tzOffsetSeconds(i)).toBe(o);
  });
});

describe('recordTime', () => {
  it('uses the record timezone for the calendar day', () => {
    // 2025-03-02T03:00:00Z is still Mar 1 at UTC-5
    const ts = Date.UTC(2025, 2, 2, 3) / 1000;
    expect(recordTime({ timeStamp: ts, timeZone: '-5:00' })?.date).toBe('2025-03-01');
  });
  it('rejects records without a timestamp', () => {
    expect(recordTime({})).toBeNull();
  });
});

describe('mapGirthRecord', () => {
  const timeStamp = Date.UTC(2025, 2, 1, 12) / 1000;
  it('maps native sites, custom sites, skips zeros, converts inches', () => {
    const out = mapGirthRecord({
      timeStamp, timeZone: '0',
      neckValue: '38.5', neckUnit: 0,
      waistValue: 32, waistUnit: 1,
      hipValue: 0, chestValue: '100', chestUnit: 0,
    });
    const byType = Object.fromEntries(out.map((e) => [e.type, e.value]));
    expect(byType).toEqual({ neck: 38.5, waist: 81.28, Chest: 100 });
    expect(out.every((e) => e.unit === 'cm' && e.date === '2025-03-01' && e.source === 'renpho')).toBe(true);
  });
});

describe('mapGirthRecord with inches', () => {
  it('keeps native sites in cm and converts custom sites', () => {
    const out = mapGirthRecord({ timeStamp: 1740830400, timeZone: '0', waistValue: 80, waistUnit: 0, chestValue: 101.6, chestUnit: 0 }, 'in');
    expect(out).toMatchObject([
      { type: 'waist', value: 80, unit: 'cm' },
      { type: 'Chest', value: 40, unit: 'in' },
    ]);
  });
});

describe('mapScaleRecord', () => {
  it('maps weight, body fat, water and bmr', () => {
    const out = mapScaleRecord({ timeStamp: 1740830400, timeZone: '0', weight: 80.2, bodyfat: 18.5, water: 55, bmr: 1700, muscle: 0 });
    expect(out.map((e) => e.type)).toEqual(['weight', 'body_fat', 'body_water_percentage', 'bmr']);
  });
});
