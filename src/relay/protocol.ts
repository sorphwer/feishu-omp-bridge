import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Relay wire protocol shared by the front (relay server) and the worker
 * (relay client). Transport is plain HTTP + SSE (no extra deps): the worker
 * dials the front with a GET that stays open as an `text/event-stream`, the
 * front pushes event frames down it, and the worker re-injects them into the
 * normal intake pipeline.
 *
 * Auth needs no extra secret. Both sides already hold the same App Secret, so
 * the relay key is derived from it via HMAC; the handshake proves possession
 * without ever sending the secret (or the derived key) on the wire.
 */

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_EVENTS_PATH = '/relay/v1/events';

/** Feishu event families the bridge forwards. */
export type RelayKind = 'message' | 'cardAction' | 'comment';

/**
 * A forwarded Feishu event. `payload` is the SDK's normalized event object
 * (`NormalizedMessage` | `CardActionEvent` | `CommentEvent`) verbatim — these
 * are plain JSON that came off the wire, so they round-trip losslessly.
 */
export interface RelayEvent {
  v: typeof RELAY_PROTOCOL_VERSION;
  /** Stable dedupe key (see {@link naturalId}) — worker drops repeats. */
  id: string;
  kind: RelayKind;
  /** Front's forward timestamp (ms epoch). */
  ts: number;
  payload: unknown;
}

// ── Handshake headers (worker → front on the SSE GET) ───────────────────────

export const RELAY_HEADERS = {
  app: 'x-relay-app',
  ts: 'x-relay-ts',
  nonce: 'x-relay-nonce',
  sig: 'x-relay-sig',
  worker: 'x-relay-worker',
  version: 'x-relay-version',
} as const;

export interface Handshake {
  appId: string;
  ts: number;
  nonce: string;
}

// ── Auth ────────────────────────────────────────────────────────────────────

const KEY_LABEL = 'feishu-omp-bridge/relay/v1';

/** Derive the relay HMAC key from the App Secret. Never sent on the wire. */
export function deriveRelayKey(appSecret: string): Buffer {
  return createHmac('sha256', appSecret).update(KEY_LABEL).digest();
}

export function signHandshake(key: Buffer, h: Handshake): string {
  return createHmac('sha256', key)
    .update(`${h.appId}.${h.ts}.${h.nonce}`)
    .digest('hex');
}

/** Constant-time hex compare; false on any length/format mismatch. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let ba: Buffer;
  let bb: Buffer;
  try {
    ba = Buffer.from(a, 'hex');
    bb = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

export interface VerifyOptions {
  /** Max clock skew between worker and front, ms. Default 5min. */
  maxSkewMs?: number;
  /** Now, ms epoch (injectable for tests). */
  now?: number;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify a handshake signature + freshness. Replay (nonce reuse) is the
 * caller's job via {@link ReplayGuard} — kept separate so this stays pure.
 */
export function verifyHandshake(
  key: Buffer,
  h: Handshake,
  sig: string,
  opts: VerifyOptions = {},
): VerifyResult {
  const maxSkew = opts.maxSkewMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now();
  if (!h.appId) return { ok: false, reason: 'missing appId' };
  if (!Number.isFinite(h.ts)) return { ok: false, reason: 'bad ts' };
  if (Math.abs(now - h.ts) > maxSkew) return { ok: false, reason: 'stale ts' };
  if (!h.nonce) return { ok: false, reason: 'missing nonce' };
  const expected = signHandshake(key, h);
  if (!safeEqualHex(expected, sig)) return { ok: false, reason: 'bad signature' };
  return { ok: true };
}

/**
 * In-memory nonce replay guard with a sliding TTL window. The window must be
 * >= the handshake skew so a replayed-but-still-fresh handshake is still
 * caught. Tiny: relay handshakes happen on (re)connect, not per event.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 10 * 60_000) {}

  /** Returns true if `nonce` is fresh (and records it); false if replayed. */
  check(nonce: string, now = Date.now()): boolean {
    this.sweep(now);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }

  private sweep(now: number): void {
    for (const [nonce, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(nonce);
    }
  }
}

// ── SSE framing ──────────────────────────────────────────────────────────────

/** Response headers that keep proxies (nginx/CDN) from buffering the stream. */
export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

/** Serialize one SSE frame. `event` defaults to "message" per the SSE spec. */
export function sseFrame(data: string, event?: string): string {
  const lines = event ? `event: ${event}\n` : '';
  // Split on newlines so multi-line JSON stays a single SSE event.
  const body = data
    .split('\n')
    .map((l) => `data: ${l}`)
    .join('\n');
  return `${lines}${body}\n\n`;
}

/** Heartbeat comment — keeps the connection (and proxy buffers) flushed. */
export const SSE_HEARTBEAT = ': ping\n\n';
export const SSE_HEARTBEAT_MS = 15_000;

// ── Dedupe ───────────────────────────────────────────────────────────────────

interface MaybeRaw {
  raw?: { header?: { event_id?: string }; event_id?: string; token?: string };
  messageId?: string;
  commentId?: string;
  replyId?: string;
  operator?: { openId?: string };
  action?: unknown;
}

/**
 * Stable id for a forwarded event so the worker can drop Feishu redeliveries
 * (and front-reconnect replays). Prefers the Feishu event envelope id; falls
 * back to family-specific natural keys.
 */
export function naturalId(kind: RelayKind, payload: unknown): string {
  const p = (payload ?? {}) as MaybeRaw;
  const eid = p.raw?.header?.event_id ?? p.raw?.event_id ?? p.raw?.token;
  if (eid) return `${kind}:${eid}`;
  if (kind === 'message' && p.messageId) return `m:${p.messageId}`;
  if (kind === 'comment') return `k:${p.commentId ?? ''}:${p.replyId ?? ''}`;
  // cardAction with no envelope id: hash the stable-ish fields.
  const h = createHmac('sha256', 'relay-natural-id')
    .update(`${p.messageId ?? ''}|${p.operator?.openId ?? ''}|${JSON.stringify(p.action ?? null)}`)
    .digest('hex')
    .slice(0, 16);
  return `a:${h}`;
}
