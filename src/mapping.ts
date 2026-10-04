import type { RenphoRecord } from './renphoClient.js';

/** One entry of the SparkyFitness `POST /api/health-data` payload. */
export interface HealthEntry {
  type: string;
  value: number;
  unit?: string;
  date: string; // YYYY-MM-DD, the user's local calendar day
  timestamp?: string; // ISO instant
  source: 'renpho';
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Parse RENPHO `timeZone` strings such as "-5:00", "+5.5" or "-5" to seconds. */
export function tzOffsetSeconds(tz: unknown): number {
  const text = String(tz ?? '').trim();
  if (!text) return 0;
  const sign = text.startsWith('-') ? -1 : 1;
  const body = text.replace(/^[+-]/, '');
  if (body.includes(':')) {
    const [h, m] = body.split(':');
    const hours = parseInt(h ?? '', 10);
    const mins = parseInt(m ?? '', 10);
    return Number.isNaN(hours) || Number.isNaN(mins) ? 0 : sign * (hours * 3600 + mins * 60);
  }
  const hours = parseFloat(body);
  return Number.isNaN(hours) ? 0 : sign * Math.round(hours * 3600);
}

/** Local calendar day and UTC instant of a record, from `timeStamp` (epoch seconds) + `timeZone`. */
export function recordTime(rec: RenphoRecord): { date: string; timestamp: string } | null {
  const ts = num(rec.timeStamp);
  if (ts === null || ts <= 0) return null;
  const local = new Date((Math.trunc(ts) + tzOffsetSeconds(rec.timeZone)) * 1000);
  return {
    date: local.toISOString().slice(0, 10),
    timestamp: new Date(Math.trunc(ts) * 1000).toISOString(),
  };
}

// Girth sites with a dedicated SparkyFitness check-in field.
const NATIVE_GIRTH: Record<string, string> = { neckValue: 'neck', waistValue: 'waist', hipValue: 'hips' };

// Remaining sites become custom measurements (category auto-created by the server).
const CUSTOM_GIRTH: Record<string, string> = {
  shoulderValue: 'Shoulder',
  chestValue: 'Chest',
  abdomenValue: 'Abdomen',
  armValue: 'Arm',
  leftArmValue: 'Left Arm',
  rightArmValue: 'Right Arm',
  thighValue: 'Thigh',
  leftThighValue: 'Left Thigh',
  rightThighValue: 'Right Thigh',
  calfValue: 'Calf',
  leftCalfValue: 'Left Calf',
  rightCalfValue: 'Right Calf',
};

const INCH_TO_CM = 2.54;

export type LengthUnit = 'cm' | 'in';

/**
 * Native check-in fields (neck/waist/hips) are always sent in cm: SparkyFitness stores cm and converts for
 * display from the user's measurement-unit preference. Custom measurements are stored as-is under a
 * category unit, so `customUnit` lets them match that preference.
 */
export function mapGirthRecord(rec: RenphoRecord, customUnit: LengthUnit = 'cm'): HealthEntry[] {
  const when = recordTime(rec);
  if (!when) return [];
  const entries: HealthEntry[] = [];
  const fields = { ...NATIVE_GIRTH, ...CUSTOM_GIRTH };
  const whr = num(rec.whrValue);
  if (whr !== null && whr > 0) {
    entries.push({ type: 'Waist-to-Hip Ratio', value: whr, unit: '', ...when, source: 'renpho' });
  }
  for (const [field, name] of Object.entries(fields)) {
    const raw = num(rec[field]);
    if (raw === null || raw <= 0) continue; // unmeasured sites come back as 0
    const unitCode = num(rec[field.replace('Value', 'Unit')]);
    const cm = unitCode === 1 ? raw * INCH_TO_CM : raw; // `*Unit: 0` is cm
    const native = NATIVE_GIRTH[field] !== undefined;
    const inches = !native && customUnit === 'in';
    entries.push({
      type: NATIVE_GIRTH[field] ?? name,
      value: Math.round((inches ? cm / INCH_TO_CM : cm) * 100) / 100,
      unit: inches ? 'in' : 'cm',
      ...when,
      source: 'renpho',
    });
  }
  return entries;
}

const EXTRA_SCALE_METRICS: readonly [field: string, name: string, unit: string][] = [
  ['bmi', 'BMI', ''],
  ['muscle', 'Skeletal Muscle Percentage', '%'],
  ['visfat', 'Visceral Fat', 'level'],
  ['subfat', 'Subcutaneous Fat', '%'],
  ['protein', 'Protein', '%'],
  ['bodyage', 'Metabolic Age', 'years'],
  ['fatFreeWeight', 'Fat Free Weight', 'kg'],
  ['heartRate', 'Scale Heart Rate', 'bpm'],
];

export function mapScaleRecord(rec: RenphoRecord): HealthEntry[] {
  const when = recordTime(rec);
  if (!when) return [];
  const entries: HealthEntry[] = [];
  const add = (type: string, field: string, unit: string, max = Infinity) => {
    const v = num(rec[field]);
    if (v !== null && v > 0 && v <= max) entries.push({ type, value: v, unit, ...when, source: 'renpho' });
  };
  add('weight', 'weight', 'kg');
  add('body_fat', 'bodyfat', '%', 100);
  add('body_water_percentage', 'water', '%', 100);
  add('bmr', 'bmr', 'kcal');
  // Field meanings verified against the RENPHO app: `sinew` is the app's "Muscle Mass" (kg), `bone` is Bone
  // Mass (kg), and `muscle` is the Skeletal Muscle *percentage*. The reference client labels these wrongly.
  add('muscle_mass_kg', 'sinew', 'kg');
  add('bone_mass_kg', 'bone', 'kg');
  // Everything else has no dedicated SparkyFitness field, so it becomes a custom measurement
  // (category auto-created).
  for (const [field, name, unit] of EXTRA_SCALE_METRICS) add(name, field, unit);
  return entries;
}
