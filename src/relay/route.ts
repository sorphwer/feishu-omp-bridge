import type {
  CardActionEvent,
  CommentEvent,
  NormalizedMessage,
} from '@larksuiteoapi/node-sdk';
import type { AppConfig, PolicyScenario } from '../config/schema';
import { relayRunTarget } from '../config/policy';
import { log } from '../core/logger';
import { naturalId, RELAY_PROTOCOL_VERSION, type RelayEvent, type RelayKind } from './protocol';

/**
 * Sink the router forwards to. The front's relay server implements this; tests
 * pass a fake. Forwarding is non-blocking and MUST NOT await the worker run —
 * the Feishu event handler has to return fast or the platform redelivers.
 */
export interface RelaySink {
  /** True when at least one worker is connected. */
  hasWorker(): boolean;
  /** Hand an event to a live worker. Returns false when none took it. */
  forward(event: RelayEvent): boolean;
}

/**
 * Decides whether an inbound Feishu event runs locally on the front or is
 * relayed to a worker. Each `route*` returns true when the event was handed
 * off (caller skips local handling) and false when it should run locally.
 *
 * Routing is purely by sender/operator trust (see {@link relayRunTarget}).
 * That keeps guests local — they only ever interact with front-rendered cards,
 * so their card actions resolve on the front — while trusted users' messages
 * and the card clicks / comments they make are relayed to the worker. Follow-up
 * routing is automatic: a trusted user's next message is relayed too, and the
 * worker's own active-run tracking turns it into a `follow_up` / `steer`.
 */
export interface RelayRouter {
  routeMessage(msg: NormalizedMessage): boolean;
  routeCardAction(evt: CardActionEvent): Promise<boolean>;
  routeComment(evt: CommentEvent): boolean;
}

export interface RelayRouterOptions {
  cfg: AppConfig;
  sink: RelaySink;
  now?: () => number;
  /**
   * Resolve a chat's scenario (p2p / group / topic) for card-action routing —
   * the event itself carries no chat type. Backed by the bridge's ChatModeCache
   * (mostly cached). Omitted in tests / when scenario gating is irrelevant, in
   * which case a restricted principal's card actions stay on the front.
   */
  resolveScenario?: (chatId: string) => Promise<PolicyScenario>;
}

export function createRelayRouter(opts: RelayRouterOptions): RelayRouter {
  const { cfg, sink } = opts;
  const now = opts.now ?? Date.now;

  const dispatch = (kind: RelayKind, chatLabel: string, payload: unknown): boolean => {
    if (!sink.hasWorker()) return false;
    const event: RelayEvent = {
      v: RELAY_PROTOCOL_VERSION,
      id: naturalId(kind, payload),
      kind,
      ts: now(),
      payload,
    };
    const taken = sink.forward(event);
    log.info('relay', taken ? 'forward' : 'forward-miss', {
      kind,
      label: chatLabel.slice(-6),
      id: event.id,
    });
    return taken;
  };

  return {
    routeMessage(msg) {
      const scenario: PolicyScenario = msg.chatType === 'p2p' ? 'p2p' : 'group';
      if (relayRunTarget(cfg, msg.senderId, scenario) !== 'worker') return false;
      return dispatch('message', msg.chatId, msg);
    },
    async routeCardAction(evt) {
      const scenario = await opts.resolveScenario?.(evt.chatId);
      if (relayRunTarget(cfg, evt.operator.openId, scenario) !== 'worker') return false;
      return dispatch('cardAction', evt.chatId, evt);
    },
    routeComment(evt) {
      // Doc comments have no chat scenario; pass undefined so an explicit
      // relayScenarios restriction keeps them on the front.
      if (relayRunTarget(cfg, evt.operator.openId, undefined) !== 'worker') return false;
      return dispatch('comment', evt.fileToken, evt);
    },
  };
}
