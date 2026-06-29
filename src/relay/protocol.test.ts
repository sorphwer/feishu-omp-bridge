import { describe, expect, it } from 'vitest';
import {
  deriveRelayKey,
  naturalId,
  ReplayGuard,
  signHandshake,
  sseFrame,
  verifyHandshake,
} from './protocol';

describe('relay auth', () => {
  const key = deriveRelayKey('app-secret');
  const h = { appId: 'cli_x', ts: 1_000_000, nonce: 'abc' };

  it('derives a stable key from the secret', () => {
    expect(deriveRelayKey('app-secret').equals(key)).toBe(true);
    expect(deriveRelayKey('other').equals(key)).toBe(false);
  });

  it('round-trips a valid handshake', () => {
    const sig = signHandshake(key, h);
    expect(verifyHandshake(key, h, sig, { now: h.ts })).toEqual({ ok: true });
  });

  it('rejects a tampered signature', () => {
    const sig = signHandshake(key, h);
    const bad = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;
    expect(verifyHandshake(key, h, bad, { now: h.ts }).ok).toBe(false);
  });

  it('rejects a signature made with the wrong key', () => {
    const sig = signHandshake(deriveRelayKey('wrong'), h);
    expect(verifyHandshake(key, h, sig, { now: h.ts }).ok).toBe(false);
  });

  it('rejects a stale timestamp', () => {
    const sig = signHandshake(key, h);
    const result = verifyHandshake(key, h, sig, { now: h.ts + 10 * 60_000 });
    expect(result).toEqual({ ok: false, reason: 'stale ts' });
  });
});

describe('ReplayGuard', () => {
  it('accepts a nonce once, rejects repeats, expires after ttl', () => {
    const guard = new ReplayGuard(1_000);
    expect(guard.check('n', 0)).toBe(true);
    expect(guard.check('n', 500)).toBe(false);
    // After the ttl window the same nonce is fresh again.
    expect(guard.check('n', 2_000)).toBe(true);
  });
});

describe('sseFrame', () => {
  it('emits an event + single-line data frame', () => {
    expect(sseFrame('{"a":1}', 'relay')).toBe('event: relay\ndata: {"a":1}\n\n');
  });

  it('splits multi-line payloads into multiple data lines', () => {
    expect(sseFrame('a\nb')).toBe('data: a\ndata: b\n\n');
  });
});

describe('naturalId', () => {
  it('prefers the Feishu event envelope id', () => {
    const payload = { messageId: 'm1', raw: { header: { event_id: 'E9' } } };
    expect(naturalId('message', payload)).toBe('message:E9');
  });

  it('falls back to messageId for messages', () => {
    expect(naturalId('message', { messageId: 'om_42' })).toBe('m:om_42');
  });

  it('keys comments by comment + reply id', () => {
    expect(naturalId('comment', { commentId: 'c1', replyId: 'r1' })).toBe('k:c1:r1');
  });

  it('is deterministic for card actions without an envelope id', () => {
    const payload = { messageId: 'm1', operator: { openId: 'ou_a' }, action: { value: { x: 1 } } };
    const a = naturalId('cardAction', payload);
    const b = naturalId('cardAction', { ...payload });
    expect(a).toBe(b);
    expect(a.startsWith('a:')).toBe(true);
  });
});
