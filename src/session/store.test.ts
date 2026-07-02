import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    await store.flush();

    const reloaded = new SessionStore(path);
    await reloaded.load();
    expect(reloaded.resumeFor('oc_1', '/work', 'full')).toBe('sid-full');
  });

  it('migrates a legacy flat entry: drops the unscoped session', async () => {
    // Pre-refactor on-disk shape: session id/cwd at the top level.
    await writeFile(
      path,
      JSON.stringify({
        oc_legacy: { sessionId: 'old-sid', cwd: '/work', updatedAt: 1 },
      }),
      'utf8',
    );
    const migrated = new SessionStore(path);
    await migrated.load();
    // Unscoped session can't be safely resumed under any profile → dropped.
    expect(migrated.resumeFor('oc_legacy', '/work', 'full')).toBeUndefined();
    expect(migrated.latestSession('oc_legacy')).toBeUndefined();
  });

  it('drops legacy entries that only carried an idle override', async () => {
    // Pre-refactor on-disk shape: a scope with nothing but a stale idle
    // override and no sessions at all — nothing worth keeping remains.
    await writeFile(
      path,
      JSON.stringify({
        chat1: { idleTimeoutMinutes: 30, updatedAt: 1 },
      }),
      'utf8',
    );
    const migrated = new SessionStore(path);
    await migrated.load();
    expect(migrated.latestSession('chat1')).toBeUndefined();
    // Force a persist and confirm the legacy-only scope did not survive
    // migration into the in-memory map at all (not just "empty sessions").
    migrated.set('chat2', 'sid', '/work', 'full');
    await migrated.flush();
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(onDisk.chat1).toBeUndefined();
  });
});
