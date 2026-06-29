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
function msg(senderId: string): NormalizedMessage {
  const m = { senderId, chatId: 'oc_1', messageId: 'om_1' } as unknown as NormalizedMessage;
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

  it('routes card actions and comments by operator trust', () => {
    const { sink, sent } = sinkSpy(true);
    const router = createRelayRouter({ cfg: cfgWith(['ou_me']), sink });
    expect(router.routeCardAction(card('ou_me'))).toBe(true);
    expect(router.routeCardAction(card('ou_guest'))).toBe(false);
    expect(router.routeComment(comment('ou_me'))).toBe(true);
    expect(router.routeComment(comment('ou_guest'))).toBe(false);
    expect(sent.map((e) => e.kind)).toEqual(['cardAction', 'comment']);
  });
});
