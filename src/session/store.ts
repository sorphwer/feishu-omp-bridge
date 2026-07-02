import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';

/** A resumable OMP session for one (scope, profile) pair. */
export interface ProfileSession {
  sessionId: string;
  /** Pinned cwd — OMP can only resume a session from the cwd it was created in. */
  cwd: string;
  updatedAt: number;
}

export interface ScopeEntry {
  /**
   * Resumable OMP sessions for this scope, keyed by the PROFILE NAME that
   * created them. Sessions are profile-scoped so a lower-privilege run never
   * resumes (and inherits the conversation context of) a higher-privilege
   * session in the same chat — and each tier keeps its own thread.
   */
  sessions: Record<string, ProfileSession>;
  updatedAt: number;
}

type SessionMap = Record<string, ScopeEntry>;

export class SessionStore {
  private data: SessionMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, unknown>;
      this.data = {};
      for (const [scope, value] of Object.entries(raw)) {
        const entry = this.migrateEntry(value);
        if (entry) this.data[scope] = entry;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  /**
   * Normalize a persisted entry into the current nested shape. Tolerates the
   * legacy FLAT shape (`{ sessionId, cwd, updatedAt }`): the flat session is
   * DROPPED (its creating profile is unknown, and resuming it under the wrong
   * profile would leak context). Returns undefined when nothing worth keeping
   * remains (i.e. no resumable sessions survived migration).
   */
  private migrateEntry(value: unknown): ScopeEntry | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const v = value as Record<string, unknown>;
    const updatedAt = typeof v.updatedAt === 'number' ? v.updatedAt : undefined;
    if (updatedAt === undefined) return undefined;

    const sessions: Record<string, ProfileSession> = {};
    if (v.sessions && typeof v.sessions === 'object') {
      for (const [profile, raw] of Object.entries(v.sessions as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue;
        const s = raw as Record<string, unknown>;
        if (typeof s.sessionId !== 'string' || typeof s.cwd !== 'string') continue;
        sessions[profile] = {
          sessionId: s.sessionId,
          cwd: s.cwd,
          updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : updatedAt,
        };
      }
    }
    // Legacy flat entry: a session with no known profile — drop it (fail-safe).
    if (Object.keys(sessions).length === 0) return undefined;
    return { sessions, updatedAt };
  }

  /**
   * Return the session id for this (scope, profile) pair if it was created in
   * the given cwd. A different profile, a different cwd, or no session at all
   * all yield undefined (= start fresh). Profile-scoping is the second half of
   * the privilege boundary: a restricted run can never resume a `full` thread.
   */
  resumeFor(scope: string, cwd: string, profile: string): string | undefined {
    const session = this.data[scope]?.sessions[profile];
    if (!session) return undefined;
    if (session.cwd !== cwd) return undefined;
    return session.sessionId;
  }

  /** The most-recently-updated session in a scope (across profiles), for the
   * /status card. undefined when the scope has no resumable session. */
  latestSession(scope: string): { sessionId: string; cwd: string; profile: string } | undefined {
    const entry = this.data[scope];
    if (!entry) return undefined;
    let best: { sessionId: string; cwd: string; profile: string; updatedAt: number } | undefined;
    for (const [profile, s] of Object.entries(entry.sessions)) {
      if (!best || s.updatedAt > best.updatedAt) {
        best = { sessionId: s.sessionId, cwd: s.cwd, profile, updatedAt: s.updatedAt };
      }
    }
    return best ? { sessionId: best.sessionId, cwd: best.cwd, profile: best.profile } : undefined;
  }

  set(scope: string, sessionId: string, cwd: string, profile: string): void {
    const prev = this.data[scope];
    const now = Date.now();
    this.data[scope] = {
      // Preserve sibling profiles' sessions.
      sessions: { ...(prev?.sessions ?? {}), [profile]: { sessionId, cwd, updatedAt: now } },
      updatedAt: now,
    };
    this.schedulePersist();
  }

  /** Drop the WHOLE scope (all profiles' sessions). Used by /new, /cd, /ws —
   * "fresh start for this chat" wipes every tier's thread. */
  clear(scope: string): void {
    if (!(scope in this.data)) return;
    delete this.data[scope];
    this.schedulePersist();
  }

  /** Drop only ONE profile's session in a scope (keep siblings). Used by the
   * resume-miss retry so a stale/expired session for one tier can self-heal
   * without wiping every other tier's thread. */
  clearProfile(scope: string, profile: string): void {
    const entry = this.data[scope];
    if (!entry || !(profile in entry.sessions)) return;
    delete entry.sessions[profile];
    entry.updatedAt = Date.now();
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      })
      .catch((err: unknown) => {
        log.fail('session', err, { step: 'persist' });
      });
  }
}
