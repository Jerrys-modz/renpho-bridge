import { createCipheriv, createDecipheriv } from 'node:crypto';

// AES-128-ECB key used by the RENPHO app for request/response payloads.
// Ported from the MIT-licensed `renpho-api` Python client.
const KEY = Buffer.from('ed*wijdi$h6fe3ew', 'utf8');

export function aesEncrypt(plaintext: string): string {
  const cipher = createCipheriv('aes-128-ecb', KEY, null);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

export function aesDecrypt(b64: string): string {
  const decipher = createDecipheriv('aes-128-ecb', KEY, null);
  return Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptRequest(obj: unknown): { encryptData: string } {
  return { encryptData: aesEncrypt(JSON.stringify(obj)) };
}

/**
 * RENPHO user ids are integers beyond 2^53 (e.g. 1616785610291582xxx). JSON.parse would round them to a
 * different number, so quote any 16+ digit integer first and keep it as an exact string.
 */
export function parseJsonKeepingBigInts<T = unknown>(text: string): T {
  const quoted = text.replace(/("(?:[^"\\]|\\.)*")|(-?\d{16,})(?![\d.eE])/g, (m, str: string | undefined) =>
    str ? m : `"${m}"`
  );
  return JSON.parse(quoted) as T;
}

export function decryptResponse<T = unknown>(b64: string): T {
  return parseJsonKeepingBigInts<T>(aesDecrypt(b64));
}
