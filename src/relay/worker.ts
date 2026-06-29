import { randomBytes } from 'node:crypto';
import { log } from '../core/logger';
import {
  deriveRelayKey,
  RELAY_EVENTS_PATH,
  RELAY_HEADERS,
  RELAY_PROTOCOL_VERSION,
  ReplayGuard,
  signHandshake,
  type RelayEvent,
} from './protocol';

/** Live worker relay client (reverse-dials the front over SSE). */
export interface RelayWorkerHandle {
  /** True while an SSE stream is open. */
  connected(): boolean;
  close(): Promise<void>;
}

export interface RelayWorkerOptions {
  appId: string;
  /** Relay key seed (relay.secret if set, else the App Secret). Never sent. */
  secret: string;
  /** Front base URL, e.g. `https://your-server.example` (path prefix preserved). */
  endpoint: string;
  workerId: string;
  /** Invoked once per fresh forwarded event (already deduped). Fire-and-forget. */
  onEvent: (event: RelayEvent) => void;
}

/** Abort + reconnect if the stream goes silent this long (front pings ~15s). */
const SILENCE_MS = 45_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export function startRelayWorker(opts: RelayWorkerOptions): RelayWorkerHandle {
  const key = deriveRelayKey(opts.secret);
  const dedupe = new ReplayGuard();
  const url = `${opts.endpoint.replace(/\/+$/, '')}${RELAY_EVENTS_PATH}`;
  let stopped = false;
  let isConnected = false;
  let controller: AbortController | undefined;

  const onFrame = (event: string, data: string): void => {
    if (event === 'welcome') {
      log.info('relay', 'worker-welcomed', { endpoint: url });
      return;
    }
    if (event !== 'relay') return;
    let parsed: RelayEvent;
    try {
      parsed = JSON.parse(data) as RelayEvent;
    } catch (err) {
      log.fail('relay', err, { phase: 'parse' });
      return;
    }
    if (parsed.v !== RELAY_PROTOCOL_VERSION) {
      log.warn('relay', 'version-skew', { got: parsed.v, want: RELAY_PROTOCOL_VERSION });
      return;
    }
    if (!dedupe.check(parsed.id)) {
      log.info('relay', 'dup-dropped', { id: parsed.id, kind: parsed.kind });
      return;
    }
    log.info('relay', 'event', { id: parsed.id, kind: parsed.kind });
    try {
      opts.onEvent(parsed);
    } catch (err) {
      log.fail('relay', err, { phase: 'dispatch', id: parsed.id });
    }
  };

  const readStream = async (body: ReadableStream<Uint8Array>, ctrl: AbortController): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let watchdog = setTimeout(() => ctrl.abort(), SILENCE_MS);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(watchdog);
        watchdog = setTimeout(() => ctrl.abort(), SILENCE_MS);
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let event = 'message';
          const dataLines: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue; // heartbeat / comment
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          if (dataLines.length > 0) onFrame(event, dataLines.join('\n'));
          sep = buf.indexOf('\n\n');
        }
      }
    } finally {
      clearTimeout(watchdog);
    }
  };

  const run = async (): Promise<void> => {
    let backoff = BACKOFF_MIN_MS;
    while (!stopped) {
      controller = new AbortController();
      const ts = Date.now();
      const nonce = randomBytes(16).toString('hex');
      try {
        const res = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            [RELAY_HEADERS.app]: opts.appId,
            [RELAY_HEADERS.ts]: String(ts),
            [RELAY_HEADERS.nonce]: nonce,
            [RELAY_HEADERS.sig]: signHandshake(key, { appId: opts.appId, ts, nonce }),
            [RELAY_HEADERS.worker]: opts.workerId,
            [RELAY_HEADERS.version]: String(RELAY_PROTOCOL_VERSION),
            accept: 'text/event-stream',
          },
        });
        if (!res.ok || !res.body) {
          log.warn('relay', 'connect-rejected', { status: res.status });
        } else {
          isConnected = true;
          backoff = BACKOFF_MIN_MS;
          log.info('relay', 'worker-connected', { endpoint: url, worker: opts.workerId });
          await readStream(res.body, controller);
        }
      } catch (err) {
        if (!stopped) {
          log.warn('relay', 'connection-lost', { err: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        isConnected = false;
      }
      if (stopped) break;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, backoff);
      await promise;
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  };

  void run();

  return {
    connected: () => isConnected,
    close() {
      stopped = true;
      controller?.abort();
      return Promise.resolve();
    },
  };
}
