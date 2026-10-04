import { aesEncrypt, decryptResponse, encryptRequest } from './crypto.js';

const API_BASE_URL = 'https://cloud.renpho.com';
const APP_VERSION = '6.6.0';
const PLATFORM = 'android';
const SUCCESS_CODES = new Set(['0', '101', '200', '20000']);

const BODY_WEIGHT_SCALES = [
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '0A',
  '0B', '0C', '0D', '0E', '0F', '10', '11', '12', '13', '14',
];

const ENDPOINTS = {
  login: 'renpho-aggregation/user/login',
  girth: 'RenphoHealth/renpho/girth/queryAllGirthsDataList',
  deviceInfo: 'renpho-aggregation/device/count',
  bodyComposition: 'RenphoHealth/scale/queryBodyCompositionMeasureData',
  scale: 'RenphoHealth/scale/queryAllMeasureDataList',
} as const;


export type RenphoRecord = Record<string, unknown>;

interface DeviceScale {
  tableName?: string;
  count?: number;
  userIds?: (string | number)[];
}

interface ApiResponse {
  code?: string | number;
  msg?: string;
  data?: string;
}

export class RenphoApiError extends Error {
  constructor(context: string, readonly code: unknown, readonly msg: string) {
    super(`${context} failed: code=${String(code)}, msg=${msg}`);
  }
}

function checkResponse(result: ApiResponse, context: string): void {
  if (String(result.msg ?? '').toLowerCase() === 'success') return;
  if (result.code !== undefined && SUCCESS_CODES.has(String(result.code))) return;
  throw new RenphoApiError(context, result.code, result.msg ?? '');
}

/** The API wraps lists in a few different shapes; normalise to an array. */
export function extractRecords(data: unknown): RenphoRecord[] {
  if (Array.isArray(data)) return data as RenphoRecord[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['list', 'data', 'records', 'rows', 'measurements']) {
      if (Array.isArray(obj[key])) return obj[key] as RenphoRecord[];
    }
    // A single bare record.
    if ('weight' in obj || 'neckValue' in obj) return [obj];
  }
  return [];
}

export class RenphoClient {
  private token: string | null = null;
  private userId: string | null = null;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly verbose = false
  ) {}

  private async post(endpoint: string, body: unknown, auth = true): Promise<ApiResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth && this.token) {
      headers.token = this.token;
      headers.userId = String(this.userId);
      headers.appVersion = APP_VERSION;
      headers.platform = PLATFORM;
    }
    const res = await this.fetchFn(`${API_BASE_URL}/${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`RENPHO ${endpoint} returned HTTP ${res.status}`);
    return (await res.json()) as ApiResponse;
  }

  async login(): Promise<void> {
    const payload = {
      questionnaire: {},
      login: {
        password: this.password,
        areaCode: 'US',
        appRevision: APP_VERSION,
        cellphoneType: 'NodeScript',
        systemType: '11',
        email: this.email,
        platform: PLATFORM,
      },
      bindingList: { deviceTypes: BODY_WEIGHT_SCALES },
    };
    const result = await this.post(ENDPOINTS.login, encryptRequest(payload), false);
    checkResponse(result, 'Login');
    const data = decryptResponse<{ login?: { token?: string; id?: string | number } }>(result.data ?? '');
    const token = data.login?.token;
    if (!token) throw new RenphoApiError('Login', null, 'No token in login response');
    this.token = token;
    this.userId = String(data.login?.id);
  }

  private async paginate(endpoint: string, extra: Record<string, unknown>, pageSize: number): Promise<RenphoRecord[]> {
    const all: RenphoRecord[] = [];
    for (let page = 1; ; page++) {
      const result = await this.post(endpoint, encryptRequest({ pageNum: page, pageSize, ...extra }));
      checkResponse(result, `${endpoint} page ${page}`);
      if (!result.data) break;
      const records = extractRecords(decryptResponse(result.data));
      if (records.length === 0) break;
      all.push(...records);
      if (records.length < pageSize) break;
    }
    return all;
  }

  /** Smart tape measure (body girth) records. */
  async getGirthMeasurements(pageSize = 100): Promise<RenphoRecord[]> {
    if (!this.token) await this.login();
    const records = await this.paginate(ENDPOINTS.girth, {}, pageSize);
    this.debug(`tape measure endpoint: ${records.length} record(s)`);
    return records;
  }

  private debug(message: string): void {
    if (this.verbose) console.log(`[debug] ${message}`);
  }

  /** Per-scale table names, record counts and linked user ids, as reported by the account. */
  async getDeviceInfo(): Promise<{ scale?: DeviceScale[] }> {
    // The app sends an encrypted empty byte array here; some accounts only answer to an empty object.
    const bodies = [{ encryptData: aesEncrypt('') }, encryptRequest({})];
    let result: ApiResponse | undefined;
    for (const [i, body] of bodies.entries()) {
      try {
        result = await this.post(ENDPOINTS.deviceInfo, body);
        break;
      } catch (err) {
        this.debug(`device info attempt ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (i === bodies.length - 1) throw err;
      }
    }
    if (!result) throw new RenphoApiError('GetDeviceInfo', null, 'no response');
    checkResponse(result, 'GetDeviceInfo');
    return decryptResponse<{ scale?: DeviceScale[] }>(result.data ?? '');
  }

  /**
   * Scale records. Table names and user ids come from the account's device info (the authoritative source).
   * Each table is read from the body-composition endpoint first, then the legacy one, because accounts
   * differ in which of the two holds the rows and the reported count is often 0 for impedance scales.
   */
  async getScaleMeasurements(pageSize = 50): Promise<RenphoRecord[]> {
    if (!this.token) await this.login();
    const info = await this.getDeviceInfo();
    const scales = info.scale ?? [];
    this.debug(
      `device info: ${scales.length} scale table(s) ${JSON.stringify(
        scales.map((sc) => ({ table: sc.tableName, count: sc.count, users: sc.userIds?.length ?? 0 }))
      )}; account userId ${this.userId}`
    );

    const all: RenphoRecord[] = [];
    const seen = new Set<string>();
    for (const sc of scales) {
      if (!sc.tableName) continue;
      const linked = (sc.userIds ?? []).map(String);
      const uid = linked.length > 0 && !linked.includes(String(this.userId)) ? linked[0] : String(this.userId);
      const extra = { userIds: [uid], tableName: sc.tableName };
      let records = await this.paginate(ENDPOINTS.bodyComposition, extra, pageSize);
      this.debug(`${sc.tableName} body-composition endpoint: ${records.length} record(s)`);
      if (records.length === 0) {
        records = await this.paginate(ENDPOINTS.scale, extra, pageSize);
        this.debug(`${sc.tableName} legacy endpoint: ${records.length} record(s)`);
      }
      for (const rec of records) {
        const key = `${sc.tableName}:${String(rec.id ?? rec.timeStamp)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(rec);
      }
    }
    return all;
  }
}
