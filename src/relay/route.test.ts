import type { CardActionEvent, CommentEvent, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/schema';
import { createRelayRouter, type RelaySink } from './route';
import type { RelayEvent } from './protocol';

function cfgWith(users: string[]): AppConfig {
  return {
    accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
    relay: { role: 'front', route: { users } },
  };
}

function sinkSpy(hasWorker: boolean): { sink: RelaySink; sent: RelayEvent[] } {
  const sent: RelayEvent[] = [];
  return {
    sent,
    sink: {
      hasWorker: () => hasWorker,
      forward: (event) => {
        sent.push(event);
        return hasWorker;
      },
    },
  };
}

// Test fixtures: only the fields the router reads are populated; cast to the
// SDK type via a named const (no inline cast into a member access).
function msg(senderId: string, chatType: 'p2p' | 'group' = 'p2p'): NormalizedMessage {
  const m = { senderId, chatId: 'oc_1', messageId: 'om_1', chatType } as unknown as NormalizedMessage;
  return m;
}
function card(openId: string): CardActionEvent {
  const c = { operator: { openId }, chatId: 'oc_1', messageId: 'om_1', action: {} } as unknown as CardActionEvent;
  return c;
}
function comment(openId: string): CommentEvent {
  const c = { operator: { openId }, fileToken: 'doc_1' } as unknown as CommentEvent;
  return c;
}

describe('relay router', () => {
  it('forwards a trusted sender to a connected worker', () => {
    const { sink, sent } = sinkSpy(true);
    const router = createRelayRouter({ cfg: cfgWith(['ou_me']), sink });
    expect(router.routeMessage(msg('ou_me'))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'message', id: 'm:om_1' });
  });

  it('handles an untrusted sender locally (no forward)', () => {
    const { sink, sent } = sinkSpy(true);
    const router = createRelayRouter({ cfg: cfgWith(['ou_me']), sink });
    expect(router.routeMessage(msg('ou_guest'))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('falls back to local when no worker is connected', () => {
    const { sink, sent } = sinkSpy(false);
    const router = createRelayRouter({ cfg: cfgWith(['ou_me']), sink });
    expect(router.routeMessage(msg('ou_me'))).toBe(false);
    expect(sent).toHaveLength(0); // dispatch short-circuits on !hasWorker
  });

  it('relays nobody when the trust list is empty (fail-safe)', () => {
    const { sink } = sinkSpy(true);
    const router = createRelayRouter({ cfg: cfgWith([]), sink });
    expect(router.routeMessage(msg('ou_me'))).toBe(false);
  });

  it('routes card actions and comments by operator trust', async () => {
    const { sink, sent } = sinkSpy(true);
    const router = createRelayRouter({ cfg: cfgWith(['ou_me']), sink });
    expect(await router.routeCardAction(card('ou_me'))).toBe(true);
    expect(await router.routeCardAction(card('ou_guest'))).toBe(false);
    expect(router.routeComment(comment('ou_me'))).toBe(true);
    expect(router.routeComment(comment('ou_guest'))).toBe(false);
    expect(sent.map((e) => e.kind)).toEqual(['cardAction', 'comment']);
  });
});

describe('relay router — scenario-scoped (relayScenarios)', () => {
  function p2pOnlyCfg(): AppConfig {
    return {
      accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
      relay: { role: 'front' },
      policy: {
        principals: { owner: { users: ['ou_me'], run: 'worker', relayScenarios: ['p2p'] } },
      },
    } as AppConfig;
  }

  it('relays owner p2p messages to the worker', () => {
    const { sink, sent } = sinkSpy(true);
    const router = createRelayRouter({ cfg: p2pOnlyCfg(), sink });
    expect(router.routeMessage(msg('ou_me', 'p2p'))).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('keeps owner group messages on the front', () => {
    const { sink, sent } = sinkSpy(true);
    const router = createRelayRouter({ cfg: p2pOnlyCfg(), sink });
    expect(router.routeMessage(msg('ou_me', 'group'))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('relays p2p card actions but keeps group card actions local', async () => {
    const p2p = sinkSpy(true);
    const p2pRouter = createRelayRouter({ cfg: p2pOnlyCfg(), sink: p2p.sink, resolveScenario: async () => 'p2p' });
    expect(await p2pRouter.routeCardAction(card('ou_me'))).toBe(true);

    const grp = sinkSpy(true);
    const grpRouter = createRelayRouter({ cfg: p2pOnlyCfg(), sink: grp.sink, resolveScenario: async () => 'group' });
    expect(await grpRouter.routeCardAction(card('ou_me'))).toBe(false);
    expect(grp.sent).toHaveLength(0);
  });

  it('keeps comments on the front under a p2p-only restriction', () => {
    const { sink, sent } = sinkSpy(true);
    const router = createRelayRouter({ cfg: p2pOnlyCfg(), sink });
    expect(router.routeComment(comment('ou_me'))).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
