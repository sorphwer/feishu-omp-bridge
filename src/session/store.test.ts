import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from './store';

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fob-sess-'));
  return join(dir, 'sessions.json');
}

describe('SessionStore per-(scope, profile) keying', () => {
  let path: string;
  let store: SessionStore;

  beforeEach(async () => {
    path = await tmpFile();
    store = new SessionStore(path);
    await store.load();
  });

  it('resumes a session only for the same profile in the same cwd', () => {
    store.set('oc_1', 'sid-full', '/work', 'full');
    expect(store.resumeFor('oc_1', '/work', 'full')).toBe('sid-full');
    // Different profile in the same chat must NOT inherit the session.
    expect(store.resumeFor('oc_1', '/work', 'kb')).toBeUndefined();
    // Same profile but a different cwd is stale.
    expect(store.resumeFor('oc_1', '/other', 'full')).toBeUndefined();
  });

  it('keeps each profile its own thread in the same scope', () => {
    store.set('oc_1', 'sid-full', '/work', 'full');
    store.set('oc_1', 'sid-kb', '/work', 'kb');
    expect(store.resumeFor('oc_1', '/work', 'full')).toBe('sid-full');
    expect(store.resumeFor('oc_1', '/work', 'kb')).toBe('sid-kb');
  });

  it('clear() wipes every profile in the scope', () => {
    store.set('oc_1', 'sid-full', '/work', 'full');
    store.set('oc_1', 'sid-kb', '/work', 'kb');
    store.clear('oc_1');
    expect(store.resumeFor('oc_1', '/work', 'full')).toBeUndefined();
    expect(store.resumeFor('oc_1', '/work', 'kb')).toBeUndefined();
  });

  it('clearProfile() drops only the named profile', () => {
    store.set('oc_1', 'sid-full', '/work', 'full');
    store.set('oc_1', 'sid-kb', '/work', 'kb');
    store.clearProfile('oc_1', 'full');
    expect(store.resumeFor('oc_1', '/work', 'full')).toBeUndefined();
    expect(store.resumeFor('oc_1', '/work', 'kb')).toBe('sid-kb');
  });

  it('preserves the idle-timeout override across session writes', () => {
    store.setIdleTimeoutMinutes('oc_1', 15);
    store.set('oc_1', 'sid-full', '/work', 'full');
    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(15);
    store.clearProfile('oc_1', 'full');
    expect(store.getIdleTimeoutMinutes('oc_1')).toBe(15);
  });

  it('latestSession reports the most-recently written profile session', () => {
    // Force distinct timestamps so the tie-break is deterministic.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000));
      store.set('oc_1', 'sid-full', '/work', 'full');
      vi.setSystemTime(new Date(2_000));
      store.set('oc_1', 'sid-kb', '/work', 'kb');
    } finally {
      vi.useRealTimers();
    }
    const latest = store.latestSession('oc_1');
    expect(latest?.profile).toBe('kb');
    expect(latest?.sessionId).toBe('sid-kb');
  });

  it('persists and reloads the nested shape', async () => {
    store.set('oc_1', 'sid-full', '/work', 'full');
    store.setIdleTimeoutMinutes('oc_1', 10);
    await store.flush();

    const reloaded = new SessionStore(path);
    await reloaded.load();
    expect(reloaded.resumeFor('oc_1', '/work', 'full')).toBe('sid-full');
    expect(reloaded.getIdleTimeoutMinutes('oc_1')).toBe(10);
  });

  it('migrates a legacy flat entry: drops the unscoped session, keeps idle override', async () => {
    // Pre-refactor on-disk shape: session id/cwd at the top level.
    await writeFile(
      path,
      JSON.stringify({
        oc_legacy: { sessionId: 'old-sid', cwd: '/work', updatedAt: 1, idleTimeoutMinutes: 20 },
        oc_bare: { sessionId: 'bare-sid', cwd: '/work', updatedAt: 2 },
      }),
      'utf8',
    );
    const migrated = new SessionStore(path);
    await migrated.load();
    // Unscoped session can't be safely resumed under any profile → dropped.
    expect(migrated.resumeFor('oc_legacy', '/work', 'full')).toBeUndefined();
    expect(migrated.latestSession('oc_legacy')).toBeUndefined();
    // The idle override survives the migration.
    expect(migrated.getIdleTimeoutMinutes('oc_legacy')).toBe(20);
    // A bare legacy session with nothing else worth keeping is dropped entirely.
    expect(migrated.getIdleTimeoutMinutes('oc_bare')).toBeUndefined();
  });
});
