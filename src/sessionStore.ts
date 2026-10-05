import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Session, SessionStore } from './renphoClient.js';

/** Keeps the RENPHO session token in a private file next to the sync state (e.g. in the Docker volume). */
export function fileSessionStore(path: string): SessionStore {
  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<Session>;
        return typeof raw.token === 'string' && typeof raw.userId === 'string'
          ? { token: raw.token, userId: raw.userId, loginAt: raw.loginAt }
          : null;
      } catch {
        return null;
      }
    },
    async save(session) {
      if (!session) {
        await rm(path, { force: true });
        return;
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(session), { mode: 0o600 });
      await chmod(path, 0o600);
    },
  };
}
