import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { log } from '../core/logger';
import {
  deriveRelayKey,
  RELAY_EVENTS_PATH,
  RELAY_HEADERS,
  RELAY_PROTOCOL_VERSION,
  ReplayGuard,
  SSE_HEADERS,
  SSE_HEARTBEAT,
  SSE_HEARTBEAT_MS,
  sseFrame,
  verifyHandshake,
  type RelayEvent,
} from './protocol';
import type { RelaySink } from './route';

/** Live front relay server. Implements {@link RelaySink} for the router. */
export interface RelayServerHandle extends RelaySink {
  /** Bound address for logs, e.g. `127.0.0.1:8787`. */
  readonly address: string;
  /** Count of currently-connected workers. */
  workerCount(): number;
  close(): Promise<void>;
}

export interface RelayServerOptions {
  appId: string;
  /** Relay key seed (relay.secret if set, else the App Secret). Never sent. */
  secret: string;
  /** `host:port` to bind. */
  listen: string;
}

interface WorkerConn {
  id: string;
  res: ServerResponse;
  heartbeat: NodeJS.Timeout;
}

const DEFAULT_LISTEN = '127.0.0.1:8787';

function parseListen(listen: string): { host: string; port: number } {
  // IPv6 bracket form [::1]:8787, or host:port, or bare :port.
  const m = listen.match(/^(\[[^\]]+\]|[^:]*):(\d+)$/);
  if (!m || !m[2]) throw new Error(`relay.listen must be host:port, got "${listen}"`);
  const host = (m[1] ?? '').replace(/^\[|\]$/g, '') || '0.0.0.0';
  return { host, port: Number(m[2]) };
}

export function startRelayServer(opts: RelayServerOptions): Promise<RelayServerHandle> {
  const { host, port } = parseListen(opts.listen || DEFAULT_LISTEN);
  const key = deriveRelayKey(opts.secret);
  const replay = new ReplayGuard();
  const conns: WorkerConn[] = [];
  let connSeq = 0;

  const drop = (conn: WorkerConn): void => {
    clearInterval(conn.heartbeat);
    const i = conns.indexOf(conn);
    if (i >= 0) conns.splice(i, 1);
    log.info('relay', 'worker-gone', { worker: conn.id, remaining: conns.length });
  };

  const handleEvents = (req: IncomingMessage, res: ServerResponse): void => {
    const header = (name: string): string =>
      (Array.isArray(req.headers[name]) ? req.headers[name]?.[0] : req.headers[name]) ?? '';
    const appId = header(RELAY_HEADERS.app);
    const ts = Number(header(RELAY_HEADERS.ts));
    const nonce = header(RELAY_HEADERS.nonce);
    const sig = header(RELAY_HEADERS.sig);
    const workerId = header(RELAY_HEADERS.worker) || `worker-${++connSeq}`;

    if (appId !== opts.appId) {
      res.writeHead(401).end('relay: app mismatch');
      return;
    }
    const verdict = verifyHandshake(key, { appId, ts, nonce }, sig);
    if (!verdict.ok) {
      log.warn('relay', 'auth-reject', { worker: workerId, reason: verdict.reason });
      res.writeHead(401).end(`relay: ${verdict.reason}`);
      return;
    }
    if (!replay.check(nonce)) {
      log.warn('relay', 'auth-reject', { worker: workerId, reason: 'nonce replay' });
      res.writeHead(401).end('relay: nonce replay');
      return;
    }

    res.writeHead(200, SSE_HEADERS);
    res.write(sseFrame(JSON.stringify({ v: RELAY_PROTOCOL_VERSION, workerId }), 'welcome'));
    const conn: WorkerConn = {
      id: workerId,
      res,
      heartbeat: setInterval(() => res.write(SSE_HEARTBEAT), SSE_HEARTBEAT_MS),
    };
    conns.push(conn);
    log.info('relay', 'worker-connected', { worker: workerId, total: conns.length });
    req.on('close', () => drop(conn));
    res.on('error', () => drop(conn));
  };

  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.split('?')[0] === RELAY_EVENTS_PATH) {
      handleEvents(req, res);
      return;
    }
    res.writeHead(404).end('not found');
  });

  const { promise, resolve, reject } = Promise.withResolvers<RelayServerHandle>();
  server.on('error', reject);
  server.listen(port, host, () => {
    server.off('error', reject);
    server.on('error', (err) => log.fail('relay', err, { phase: 'server' }));
    const bound = server.address();
    const address = bound && typeof bound === 'object' ? `${host}:${bound.port}` : `${host}:${port}`;
    log.info('relay', 'listening', { address });
    resolve({
      address,
      hasWorker: () => conns.length > 0,
      workerCount: () => conns.length,
      forward(event: RelayEvent) {
        // Most-recently-connected worker wins (single-worker is the norm).
        const conn = conns[conns.length - 1];
        if (!conn) return false;
        try {
          // res.write() returns false under backpressure but the frame is
          // still queued — treat a live connection as accepted so the front
          // never also handles locally and spawns a duplicate run.
          const flushed = conn.res.write(sseFrame(JSON.stringify(event), 'relay'));
          if (!flushed) log.info('relay', 'backpressure', { worker: conn.id });
          return true;
        } catch (err) {
          log.fail('relay', err, { phase: 'forward', worker: conn.id });
          drop(conn);
          return false;
        }
      },
      close() {
        const { promise: closed, resolve: done } = Promise.withResolvers<void>();
        for (const conn of [...conns]) {
          clearInterval(conn.heartbeat);
          conn.res.end();
        }
        conns.length = 0;
        server.close(() => done());
        return closed;
      },
    });
  });
  return promise;
}
