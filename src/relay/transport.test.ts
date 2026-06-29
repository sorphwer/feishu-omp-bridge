import { afterEach, describe, expect, it } from 'vitest';
import { startRelayServer, type RelayServerHandle } from './front';
import { RELAY_EVENTS_PATH, RELAY_PROTOCOL_VERSION, type RelayEvent } from './protocol';
import { startRelayWorker, type RelayWorkerHandle } from './worker';

const APP = 'cli_test';
const SECRET = 'shared-secret';

let server: RelayServerHandle | undefined;
let worker: RelayWorkerHandle | undefined;

afterEach(async () => {
  await worker?.close();
  await server?.close();
  worker = undefined;
  server = undefined;
});

async function waitFor(pred: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
}

function event(id: string): RelayEvent {
  return { v: RELAY_PROTOCOL_VERSION, id, kind: 'message', ts: Date.now(), payload: { hello: id } };
}

describe('relay transport (front ↔ worker over loopback)', () => {
  it('connects, forwards an event, and dedupes redeliveries', async () => {
    server = await startRelayServer({ appId: APP, secret: SECRET, listen: '127.0.0.1:0' });
    const received: RelayEvent[] = [];
    worker = startRelayWorker({
      appId: APP,
      secret: SECRET,
      endpoint: `http://${server.address}`,
      workerId: 'test-worker',
      onEvent: (e) => received.push(e),
    });

    await waitFor(() => server!.workerCount() > 0);

    expect(server.forward(event('e1'))).toBe(true);
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({ id: 'e1', kind: 'message' });

    // Redelivery of the same id is dropped by the worker's dedupe guard.
    server.forward(event('e1'));
    server.forward(event('e2'));
    await waitFor(() => received.some((e) => e.id === 'e2'));
    expect(received.filter((e) => e.id === 'e1')).toHaveLength(1);
  }, 10_000);

  it('rejects a connection without a valid handshake', async () => {
    server = await startRelayServer({ appId: APP, secret: SECRET, listen: '127.0.0.1:0' });
    const res = await fetch(`http://${server.address}${RELAY_EVENTS_PATH}`);
    await res.text();
    expect(res.status).toBe(401);
  }, 10_000);

  it('rejects a worker presenting the wrong secret', async () => {
    server = await startRelayServer({ appId: APP, secret: SECRET, listen: '127.0.0.1:0' });
    worker = startRelayWorker({
      appId: APP,
      secret: 'wrong-secret',
      endpoint: `http://${server.address}`,
      workerId: 'bad-worker',
      onEvent: () => {},
    });
    // Give it time to attempt; it must never register.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 300);
    await promise;
    expect(server.workerCount()).toBe(0);
  }, 10_000);
});
