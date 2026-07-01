import { homedir, hostname } from 'node:os';
import type {
  CardActionEvent,
  CommentEvent,
  LarkChannel,
  LarkChannelOptions,
  NormalizedMessage,
} from '@larksuiteoapi/node-sdk';
import { Domain, LoggerLevel, createLarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentAdapter, AgentUiRequest } from '../agent/types';
import { isSessionMissingError } from '../agent/omp/adapter';
import { handleCardAction } from '../card/dispatcher';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { renderOmpUiRequestCard, renderOmpUiResultCard } from '../card/omp-ui';
import { renderCard } from '../card/run-renderer';
import {
  finalizeIfRunning,
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunBadge,
  type RunState,
} from '../card/run-state';
import { renderText } from '../card/text-renderer';
import { tryHandleCommand, type Controls } from '../commands';
import type { AppConfig } from '../config/schema';
import {
  getAgentStopGraceMs,
  getOmpModel,
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getRequireMentionInGroup,
  getRunIdleTimeoutMs,
  getRelayConfig,
  getShowToolCalls,
  isChatAllowed,
  isUserAllowed,
} from '../config/schema';
import { injectionDecision, resolveBatchProfile } from '../config/policy';
import { resolveAppSecret, resolveRelaySecret } from '../config/secret-resolver';
import { log, withTrace } from '../core/logger';
import { MediaCache, type LocalAttachment } from '../media/cache';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { ActiveRuns, type RunHandle } from './active-runs';
import { ChatModeCache, type ChatMode } from './chat-mode-cache';
import { handleCommentMention } from './comments';
import { buildCommandTools } from './command-tools';
import { buildProfileRunArgs, type GuestRunArgs } from './guest-lockdown';
import { createFeishuHostIntegration } from './feishu-host';
import { expandInteractiveCard } from './interactive-card';
import { startKeepalive } from './keepalive';
import { configureNetwork, type NetworkOverrides } from './network-config';
import { PendingQueue } from './pending-queue';
import { ProcessPool } from './process-pool';
import { scopeForMessage } from './scope';
import { fetchQuotedContext, renderQuotedBlock, type QuotedContext } from './quote';
import { addReaction, removeReaction, REACTION_DEFERRED } from './reaction';
import { startRelayServer, type RelayServerHandle } from '../relay/front';
import { createRelayRouter, type RelayRouter } from '../relay/route';
import { startRelayWorker } from '../relay/worker';

const DEBOUNCE_MS = 600;

// Lark SDK logs API errors at error level even when the caller catches them.
// These specific codes are EXPECTED in our flow (wiki-node lookup that
// usually misses, fileComment.get that we deliberately let fall back to
// .list) and the surrounding noise is already covered by our own logs.
const SUPPRESSED_API_ERROR_CODES = new Set([
  131005, // wiki.space.getNode "not found" — the doc isn't a wiki node
  1069307, // drive.fileComment.get "not exist" — fall back to .list
  1069302, // drive.fileCommentReply.create — whole-doc comments don't accept replies; fall back to fileComment.create
]);

function buildQuietLogger(): {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
} {
  // Match either `{ code: <feishu-code> }` (the response data SDK logs as
  // its second arg) or an AxiosError where the feishu code lives at
  // `err.response.data.code` (which the SDK logs raw).
  const codeFromObj = (m: unknown): number | undefined => {
    if (!m || typeof m !== 'object') return undefined;
    const top = (m as { code?: unknown }).code;
    if (typeof top === 'number') return top;
    const nested = (m as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof nested === 'number' ? nested : undefined;
  };
  const isSuppressed = (msg: unknown): boolean => {
    if (Array.isArray(msg)) return msg.some(isSuppressed);
    const code = codeFromObj(msg);
    return code !== undefined && SUPPRESSED_API_ERROR_CODES.has(code);
  };
  return {
    error: (...args: unknown[]) => {
      if (args.some(isSuppressed)) return;
      log.warn('sdk', 'error', { args: stringifyArgs(args) });
    },
    warn: (...args: unknown[]) => log.warn('sdk', 'warn', { args: stringifyArgs(args) }),
    info: (...args: unknown[]) => log.info('sdk', 'info', { args: stringifyArgs(args) }),
    debug: () => {},
    trace: () => {},
  };
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface BridgeChannel {
  channel: LarkChannel;
  disconnect(): Promise<void>;
}

export interface StartChannelDeps {
  cfg: AppConfig;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Controls;
}

/** Shared LarkChannel options. `appSecret` is pre-resolved; `transport` is
 * added by callers (worker uses `'none'` to stay outbound-only). */
function buildChannelOptions(
  cfg: AppConfig,
  appSecret: string,
  netOverrides: NetworkOverrides,
): LarkChannelOptions {
  return {
    appId: cfg.accounts.app.id,
    appSecret,
    domain: cfg.accounts.app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'feishu-omp-bridge',
    loggerLevel: LoggerLevel.info,
    logger: buildQuietLogger(),
    policy: {
      dmMode: 'open',
      requireMention: false,
      respondToMentionAll: false,
    },
    // Disable per-chat serialization so we can implement our own
    // debounce + run-chain policy (see pending-queue + runChain below).
    safety: {
      chatQueue: { enabled: false },
    },
    // Attach raw Feishu event body to normalized events so we can read fields
    // the normalizer drops (e.g. action.form_value on CardKit 2.0 form submits).
    includeRawEvent: true,
    outbound: {
      streamThrottleMs: 400,
    },
    // SDK 1.65.0-alpha.3+ knobs.
    wsConfig: {
      // 3s liveness watchdog: if no inbound message arrives within 3s after
      // the last ping, SDK presumes connection dead and forces a reconnect.
      pingTimeout: 3,
    },
    // 8s handshake timeout (replaces hardcoded 15s). Fast-fail + fast-retry
    // beats slow-fail in unstable networks.
    handshakeTimeoutMs: 8_000,
    // Optional WS-layer proxy agent (only when HTTPS_PROXY / HTTP_PROXY env set).
    ...(netOverrides.agent ? { agent: netOverrides.agent } : {}),
  };
}

/**
 * The per-instance message pipeline bound to one channel: intake → debounce →
 * run, plus card-action and comment handling. Both the front (driven by the
 * Feishu WS) and a worker (driven by relayed events) build one of these and
 * feed it events through the same three `dispatch*` entry points.
 */
export interface BridgeRuntime {
  dispatchMessage(msg: NormalizedMessage): Promise<void>;
  dispatchCardAction(evt: CardActionEvent): Promise<void>;
  dispatchComment(evt: CommentEvent): Promise<void>;
  /** Shared chat-mode cache (p2p/group/topic). Reused by the relay router to
   * resolve a card action's scenario for per-principal `relayScenarios`. */
  readonly chatModeCache: ChatModeCache;
  /** Stop runs + flush stores. Does NOT touch the channel itself. */
  shutdown(): Promise<void>;
}

export interface BridgeRuntimeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: Controls;
}

export function createBridgeRuntime(deps: BridgeRuntimeDeps): BridgeRuntime {
  const { channel, agent, sessions, workspaces, controls } = deps;
  const activeRuns = new ActiveRuns();
  // ChatModeCache stays per-bridge-instance — invalidated on restart along
  // with everything else. Topic-mode chats only need one chat.get() call ever.
  const chatModeCache = new ChatModeCache();
  // Concurrency cap — reads `preferences.maxConcurrentRuns` on each acquire,
  // so /config bumps take effect for the next run.
  const pool = new ProcessPool(() => getMaxConcurrentRuns(controls.cfg));
  const media = new MediaCache(channel);

  // Pending → run handoff: while a run is active on a chat, block its pending
  // queue so messages keep accumulating without flushing. When the run ends,
  // unblock arms a fresh quiet-window timer. Net effect: at most one run per
  // chat in flight, and everything sent during a run merges into the next
  // batch (only flushed once 600ms of silence has passed *after* the run).
  const pending = new PendingQueue(DEBOUNCE_MS, (scope, batch) => {
    const firstMsg = batch[0];
    if (!firstMsg) return;
    pending.block(scope);
    void withTrace({ chatId: firstMsg.chatId }, async () => {
      log.info('flush', 'start', { scope, batchSize: batch.length });
      // Pool slot acquired here, released in finally. Across-the-bridge cap.
      const release = await pool.acquire();
      try {
        const mode = await chatModeCache.resolve(channel, firstMsg.chatId);
        await runAgentBatch({
          channel,
          agent,
          sessions,
          workspaces,
          activeRuns,
          media,
          batch,
          controls,
          scope,
          mode,
        });
      } catch (err) {
        log.fail('flush', err);
      } finally {
        release();
        pending.unblock(scope);
        log.info('flush', 'end');
      }
    });
  });

  return {
    chatModeCache,
    dispatchMessage: (msg) =>
      intakeMessage({
        channel,
        agent,
        sessions,
        workspaces,
        activeRuns,
        media,
        pending,
        msg,
        controls,
        chatModeCache,
      }),
    dispatchCardAction: (evt) =>
      handleCardAction({
        channel,
        evt,
        sessions,
        workspaces,
        activeRuns,
        agent,
        controls,
        pending,
        chatModeCache,
      }),
    dispatchComment: (evt) => handleCommentMention({ channel, evt, agent, sessions, workspaces, cfg: controls.cfg }),
    shutdown: async () => {
      pending.cancelAll();
      await activeRuns.stopAll();
      await Promise.allSettled([sessions.flush(), workspaces.flush()]);
    },
  };
}

export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, workspaces, controls } = deps;

  // Apply network-layer overrides (HTTP timeout + proxy from env). Idempotent;
  // safe to call on every startChannel (used by /account change hot-reload too).
  const netOverrides = configureNetwork();
  // Resolve the App Secret to plaintext. Re-resolved on every startChannel so
  // /account change picks up new secrets. Also the relay HMAC key seed.
  const appSecret = await resolveAppSecret(cfg);

  const channel = createLarkChannel(buildChannelOptions(cfg, appSecret, netOverrides));
  const runtime = createBridgeRuntime({ channel, agent, sessions, workspaces, controls });

  // Front relay: forward trusted senders to a connected worker; everyone else
  // (and trusted senders when no worker is online) runs locally on the front.
  const relay = getRelayConfig(cfg);
  let relayServer: RelayServerHandle | undefined;
  let router: RelayRouter | undefined;
  if (relay?.role === 'front') {
    relayServer = await startRelayServer({
      appId: cfg.accounts.app.id,
      secret: await resolveRelaySecret(cfg, appSecret),
      listen: relay.listen ?? '127.0.0.1:8787',
    });
    router = createRelayRouter({
      cfg,
      sink: relayServer,
      resolveScenario: (chatId) => runtime.chatModeCache.resolve(channel, chatId),
    });
    log.info('relay', 'front-ready', { address: relayServer.address });
    console.log(`relay front 已监听 ${relayServer.address}（worker 拨入此地址）\n`);
  }

  // Counter for stdout reconnect escalation; reset on `reconnected`.
  let consecutiveReconnects = 0;

  channel.on({
    message: async (msg) => {
      await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
        // Forwarding is non-blocking and returns immediately — the WS handler
        // must ack fast or Feishu redelivers. The worker dedupes by event id.
        if (router?.routeMessage(msg)) return;
        await runtime.dispatchMessage(msg);
      }).catch((err) => log.fail('intake', err));
    },
    reject: (evt) => {
      log.info('intake', 'reject', { chatId: evt.chatId, reason: evt.reason });
    },
    cardAction: async (evt) => {
      await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
        if (await router?.routeCardAction(evt)) return;
        await runtime.dispatchCardAction(evt);
      }).catch((err) => log.fail('cardAction', err));
    },
    comment: async (evt) => {
      await withTrace({ chatId: 'comment' }, async () => {
        if (router?.routeComment(evt)) return;
        await runtime.dispatchComment(evt);
      }).catch((err) => log.fail('comment', err));
    },
    reconnecting: () => {
      consecutiveReconnects++;
      log.warn('ws', 'reconnecting', { consecutive: consecutiveReconnects });
      // Stdout escalation — surface jitter that's hidden in the file log.
      if (consecutiveReconnects === 3) {
        console.error('⚠️ 已连续重连 3 次,网络可能不稳。');
      } else if (consecutiveReconnects === 10) {
        console.error('❌ 已连续重连 10 次,建议在飞书发 /reconnect 或重启 bot。');
      }
    },
    reconnected: () => {
      if (consecutiveReconnects > 1) {
        log.info('ws', 'recovered', { afterAttempts: consecutiveReconnects });
      } else {
        log.info('ws', 'reconnected');
      }
      consecutiveReconnects = 0;
    },
    // Classify common WS errors into the `network` phase so /doctor and grep
    // can find them without scanning generic `ws.fail` entries.
    error: (err) => {
      const msg = err?.message ?? String(err);
      if (/ENOTFOUND|getaddrinfo/.test(msg)) {
        log.fail('network', err, { kind: 'dns', code: err.code });
      } else if (/handshake|did not complete/.test(msg)) {
        log.fail('network', err, { kind: 'handshake-timeout', code: err.code });
      } else if (/timeout/i.test(msg)) {
        log.fail('network', err, { kind: 'timeout', code: err.code });
      } else {
        log.fail('ws', err, { code: err.code });
      }
    },
  });

  await channel.connect();

  const identity = channel.botIdentity;
  log.info('ws', 'connected', {
    bot: identity?.name ?? 'unknown',
    openId: identity?.openId ?? '-',
    agent: `${agent.displayName} (${agent.id})`,
    appId: cfg.accounts.app.id,
    procId: controls.processId,
  });
  console.log('正在监听消息。按 Ctrl+C 退出。\n');

  // App-level keepalive: 15s probe + wake-up detection + HTTP reachability.
  // Defense-in-depth — the SDK's pingTimeout watchdog handles half-dead WS,
  // this catches anything that the SDK misses (silent state stuck, etc.).
  const probeDomain =
    cfg.accounts.app.tenant === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';
  const keepalive = startKeepalive({
    channel,
    domain: probeDomain,
    forceReconnect: () => controls.restart(),
  });

  return {
    channel,
    disconnect: async () => {
      keepalive.stop();
      await relayServer?.close();
      await channel.disconnect();
      await runtime.shutdown();
    },
  };
}

/**
 * Worker mode: do NOT open the Feishu WS (a 2nd long-connection on the same
 * app makes delivery random). Build an outbound-only channel — `transport:
 * 'webhook'` tells the SDK not to open the WebSocket long-connection, so
 * connect() only fetches the bot identity over REST — then drive the pipeline
 * from events relayed by a front. (We never actually receive webhooks; events
 * arrive via the relay client.)
 */
export async function startWorker(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { cfg, agent, sessions, workspaces, controls } = deps;
  const relay = getRelayConfig(cfg);
  if (relay?.role !== 'worker' || !relay.endpoint) {
    throw new Error('worker mode requires relay.role "worker" and relay.endpoint');
  }

  const netOverrides = configureNetwork();
  const appSecret = await resolveAppSecret(cfg);
  const opts: LarkChannelOptions = {
    ...buildChannelOptions(cfg, appSecret, netOverrides),
    transport: 'webhook',
  };
  const channel = createLarkChannel(opts);
  try {
    // Identity bootstrap only — under transport:'webhook' connect() is a single
    // REST call (/open-apis/bot/v3/info), no WebSocket. Best-effort: outbound
    // still works without it (only quote bot-detection degrades).
    await channel.connect();
  } catch (err) {
    log.warn('relay', 'identity-bootstrap-failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const runtime = createBridgeRuntime({ channel, agent, sessions, workspaces, controls });
  const workerId = relay.workerId ?? hostname();
  // Plain non-loopback HTTP: the HMAC handshake authenticates the worker, but
  // the event stream itself is unencrypted and unauthenticated — an active MITM
  // can read or forge events (which drive the local full-tool agent). Use https
  // (TLS) for the relay endpoint, or add per-frame MACs.
  if (/^http:\/\//i.test(relay.endpoint) && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(relay.endpoint)) {
    log.warn('relay', 'insecure-endpoint', { endpoint: relay.endpoint });
    console.warn(
      `⚠️ relay.endpoint 是明文 http(${relay.endpoint}):握手 HMAC 只认证 worker,事件流未加密、可被中间人读取/伪造。请改用 https。`,
    );
  }
  const worker = startRelayWorker({
    appId: cfg.accounts.app.id,
    secret: await resolveRelaySecret(cfg, appSecret),
    endpoint: relay.endpoint,
    workerId,
    onEvent: (event) => {
      void withTrace({ chatId: `relay:${event.kind}`, msgId: event.id }, async () => {
        if (event.kind === 'message') {
          await runtime.dispatchMessage(event.payload as NormalizedMessage);
        } else if (event.kind === 'cardAction') {
          await runtime.dispatchCardAction(event.payload as CardActionEvent);
        } else if (event.kind === 'comment') {
          await runtime.dispatchComment(event.payload as CommentEvent);
        }
      }).catch((err) => log.fail('relay', err, { phase: 'inject', id: event.id }));
    },
  });

  log.info('relay', 'worker-mode', {
    endpoint: relay.endpoint,
    worker: workerId,
    bot: channel.botIdentity?.name ?? 'unknown',
    agent: `${agent.displayName} (${agent.id})`,
    procId: controls.processId,
  });
  console.log(`worker 模式已启动，连接 ${relay.endpoint}。按 Ctrl+C 退出。\n`);

  return {
    channel,
    disconnect: async () => {
      await worker.close();
      await channel.disconnect();
      await runtime.shutdown();
    },
  };
}

/** Start the bridge in the role configured by `relay.role` (worker vs the
 * default front/standalone WS bridge). Single entry point for runStart and
 * the /account hot-restart. */
export async function startBridge(deps: StartChannelDeps): Promise<BridgeChannel> {
  return getRelayConfig(deps.cfg)?.role === 'worker' ? startWorker(deps) : startChannel(deps);
}

interface IntakeDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  media: MediaCache;
  pending: PendingQueue;
  msg: NormalizedMessage;
  controls: Controls;
  chatModeCache: ChatModeCache;
}

async function intakeMessage(deps: IntakeDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    workspaces,
    activeRuns,
    media,
    pending,
    msg,
    controls,
    chatModeCache,
  } = deps;
  const preview = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
  // Resolve the session scope (thread-aware) and the chat mode once at intake —
  // every downstream consumer keys off these. Scope isolates by thread_id
  // whenever present (topic groups AND thread-enabled normal groups); chatMode
  // stays Feishu's chat_mode for policy scenario matching + logging.
  const chatMode = await chatModeCache.resolve(channel, msg.chatId);
  const scope = scopeForMessage(msg);
  log.info('intake', 'enter', {
    scope,
    chatType: msg.chatType,
    chatMode,
    sender: msg.senderId,
    preview,
    resources: msg.resources.length,
  });

  // Access control. Silent drop — replying would reveal the bot to
  // unauthorized users and let them spam the chat with denial messages.
  // Operator-defined lists; both empty = allow all (back-compat).
  if (!isUserAllowed(controls.cfg, msg.senderId)) {
    log.info('intake', 'skip-not-allowed-user', {
      scope,
      sender: msg.senderId.slice(-6),
    });
    return;
  }
  // `allowedChats` is intentionally a group-only gate. p2p chat_ids are
  // generated per-user-pair and can't be hijacked by an unauthorized
  // sender, so the user allowlist above is already authoritative for DMs.
  // Restricting p2p by chat_id would also create a chicken-and-egg lockout
  // hazard (the operator must know the chat_id before they ever DM the bot).
  if (msg.chatType !== 'p2p' && !isChatAllowed(controls.cfg, msg.chatId)) {
    log.info('intake', 'skip-not-allowed-chat', {
      scope,
      chatId: msg.chatId.slice(-6),
    });
    return;
  }

  // Group-mention policy. p2p is always unrestricted; in groups (regular and
  // topic) we drop messages that don't @bot when the user has opted into the
  // quiet-by-default behavior. Slash commands are NOT exempt — the user
  // chose strict mode so the group stays uniformly quiet unless mentioned.
  // @全员 is already filtered by SDK (`respondToMentionAll: false`), so any
  // event reaching here is either targeted or undirected chatter.
  if (
    msg.chatType !== 'p2p' &&
    getRequireMentionInGroup(controls.cfg) &&
    !msg.mentionedBot
  ) {
    log.info('intake', 'skip-no-mention', { scope, chatType: msg.chatType });
    return;
  }

  const handled = await tryHandleCommand({
    channel,
    msg,
    scope,
    chatMode,
    sessions,
    workspaces,
    agent,
    activeRuns,
    controls,
  });
  if (handled) {
    const dropped = pending.cancel(scope);
    log.info('intake', 'command', { scope, droppedPending: dropped.length });
    return;
  }

  const submitted = await submitToActiveRun({
    channel,
    activeRuns,
    media,
    msg,
    scope,
    chat: chatMode,
    cfg: controls.cfg,
  });
  if (submitted === 'injected') {
    log.info('intake', 'submitted-active-run', { scope });
    return;
  }
  // 'deferred' (or 'no-run') falls through to the pending queue: the message
  // re-resolves under its OWN sender's profile after the active run ends.

  const size = pending.push(scope, msg);
  log.info('intake', 'queued', { scope, queueSize: size, debounceMs: DEBOUNCE_MS });
}

async function submitToActiveRun(deps: {
  channel: LarkChannel;
  activeRuns: ActiveRuns;
  media: MediaCache;
  msg: NormalizedMessage;
  scope: string;
  chat: ChatMode;
  cfg: AppConfig;
}): Promise<'injected' | 'deferred' | 'no-run'> {
  const { channel, activeRuns, media, msg, scope, chat, cfg } = deps;
  const activeProfile = activeRuns.profileName(scope);
  // Mid-run join gate: a message may only be injected into the active run when
  // its own sender resolves to the SAME profile that run was spawned with.
  // Otherwise it would execute under permissions the sender isn't entitled to
  // (the group escalation: a low-privilege member riding a `full` run). Such a
  // message is DEFERRED — it returns to the pending queue and runs after the
  // active run ends, under its own profile.
  const decision = injectionDecision(cfg, msg.senderId, { chat, chatId: msg.chatId }, activeProfile);
  if (decision === 'no-run') return 'no-run';
  if (decision === 'defer') {
    log.info('intake', 'mid-run-deferred', {
      scope,
      sender: msg.senderId.slice(-6),
      activeProfile,
    });
    // Non-spammy ack: signal "received, will answer after the current run".
    await addReaction(channel, msg.messageId, REACTION_DEFERRED);
    return 'deferred';
  }
  const resources = msg.resources.map((resource) => ({ messageId: msg.messageId, resource }));
  const attachments = await media.resolve(msg.chatId, resources);
  const imagePaths = attachments.filter((attachment) => attachment.kind === 'image').map((attachment) => attachment.path);
  const quotes: QuotedContext[] = [];
  if (msg.replyToMessageId) {
    const quote = await fetchQuotedContext(channel, msg.replyToMessageId);
    if (quote) quotes.push(quote);
  }
  const prompt = buildPrompt([msg], attachments, quotes);
  const trimmed = msg.content.trimStart();
  const kind = trimmed.startsWith('!') ? 'steer' : 'follow_up';
  const ok = await activeRuns.submitPrompt(scope, kind, prompt, imagePaths);
  // A race (run ended between the gate and submit) leaves the message unhandled;
  // defer it to the pending queue rather than dropping it.
  return ok ? 'injected' : 'no-run';
}

interface RunBatchDeps {
  channel: LarkChannel;
  agent: AgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  media: MediaCache;
  batch: NormalizedMessage[];
  controls: Controls;
  scope: string;
  mode: ChatMode;
}

interface AgentStreamHooks {
  onUiRequest(request: AgentUiRequest): Promise<void>;
  onUiCancel(targetId: string): Promise<void>;
}

async function runAgentBatch(deps: RunBatchDeps): Promise<void> {
  const {
    channel,
    agent,
    sessions,
    workspaces,
    activeRuns,
    media,
    batch,
    controls,
    scope,
    mode,
  } = deps;
  if (batch.length === 0) return;
  const firstMsg = batch[0];
  const lastMsg = batch[batch.length - 1];
  if (!firstMsg || !lastMsg) return;

  const chatId = firstMsg.chatId;
  const threadId = firstMsg.threadId;

  const resourceItems = batch.flatMap((m) =>
    m.resources.map((r) => ({ messageId: m.messageId, resource: r })),
  );
  const attachments = await media.resolve(chatId, resourceItems);
  if (attachments.length > 0) {
    log.info('media', 'resolved', { count: attachments.length });
  }
  const imagePaths = attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => attachment.path);

  // Collect any reply-quote targets in the batch. Dedup so the same target
  // quoted by multiple messages in one batch only fetches once. Filter out
  // ids that are themselves in the batch — those are already in the prompt.
  const batchIds = new Set(batch.map((m) => m.messageId));
  const quoteTargets = [
    ...new Set(
      batch
        .map((m) => m.replyToMessageId)
        .filter((id): id is string => Boolean(id) && !batchIds.has(id!)),
    ),
  ];
  const quotes: QuotedContext[] = [];
  for (const targetId of quoteTargets) {
    const q = await fetchQuotedContext(channel, targetId);
    if (q) {
      quotes.push(q);
      log.info('quote', 'fetched', {
        messageId: targetId,
        type: q.rawContentType,
        contentChars: q.content.length,
      });
    }
  }

  const prompt = buildPrompt(batch, attachments, quotes);
  log.info('prompt', 'built', { promptChars: prompt.length, quotes: quotes.length });

  const cwd = workspaces.cwdFor(scope) ?? homedir();

  // Resolve the agent profile for this batch from the unified policy
  // (principals × scenario × first-match rules). The most-restrictive sender
  // wins, so one untrusted sender can't lift the batch. A profile with a
  // `tools` ARRAY is a sandbox (restricted built-ins + discovery/memory off +
  // fail-closed hook); `full` keeps the whole tool set. Absent `policy`, this
  // reproduces the legacy access/guest matrix. See config/policy.ts.
  const { profile, principals } = resolveBatchProfile(
    controls.cfg,
    batch.map((m) => m.senderId),
    { chat: mode, chatId },
  );

  // Sessions are keyed by (scope, profile): a run only resumes a thread its OWN
  // profile created, so a lower-privilege run never inherits a `full` session's
  // context in a shared chat, and each tier keeps its own conversation thread.
  const resumeFrom = sessions.resumeFor(scope, cwd, profile.name);
  if (resumeFrom) {
    log.info('session', 'resume', { sessionId: resumeFrom, cwd, profile: profile.name });
  } else {
    log.info('session', 'fresh', { cwd, profile: profile.name });
  }

  const feishuHost = createFeishuHostIntegration(channel, {
    scope,
    chatId,
    threadId,
    replyToMessageId: lastMsg.messageId,
    cwd,
  });

  // Host-tool surface follows the profile for EVERY profile (not just
  // restricted): Feishu host tools only when `feishuHostTools` is on, plus any
  // command tools the profile declares. The `feishu://` scheme can read
  // arbitrary messages by id, so it rides the same flag. `buildProfileRunArgs`
  // emits `--tools`/hook only for restricted profiles and the discovery/memory
  // overlay whenever the profile turns either off (so a `full` profile's
  // discovery/memory/feishu knobs are never silently ignored).
  const guestArgs: GuestRunArgs = await buildProfileRunArgs(profile);
  const commandTools = buildCommandTools(profile.commandTools, cwd);
  const hostTools = profile.feishuHostTools
    ? [...feishuHost.tools, ...commandTools]
    : commandTools;
  const hostUriSchemes = profile.feishuHostTools ? feishuHost.uriSchemes : [];
  let runPrompt = prompt;
  // Profile system prompt is PREPENDED to the user prompt (same proven path as
  // OMP_BRIDGE_PROMPT). NOT via `--append-system-prompt`: appending an extra
  // system block destabilizes the codex (gpt-5.5) request and intermittently
  // hangs the run with no output — observed as "guest gets no reply".
  if (profile.systemPrompt) runPrompt = `${profile.systemPrompt}\n\n---\n\n${prompt}`;
  log.info('policy', 'resolved', {
    scope,
    chat: mode,
    principals,
    profile: profile.name,
    restricted: profile.restricted,
    tools: guestArgs?.tools,
    hostToolCount: hostTools.length,
    systemPrompt: Boolean(profile.systemPrompt),
  });

  // Card header badge: advertise the run's tool mode + originator so everyone
  // in a shared chat can see what permissions the conversation holds (and why a
  // lower-privilege member's mid-run message gets deferred). Group/topic only —
  // p2p is single-party. Snapshot now (run-start), never a live cfg lookup.
  const badge: RunBadge | undefined =
    mode === 'p2p'
      ? undefined
      : { profileName: profile.name, restricted: profile.restricted, owner: firstMsg.senderName };
  const runInitialState: RunState = badge ? { ...initialState, badge } : initialState;

  const spawnHandle = (sessionId: string | undefined): RunHandle =>
    activeRuns.register(
      scope,
      agent.run({
        prompt: runPrompt,
        sessionId,
        cwd,
        model: getOmpModel(controls.cfg),
        imagePaths,
        stopGraceMs: getAgentStopGraceMs(controls.cfg),
        hostTools,
        hostUriSchemes,
        tools: guestArgs?.tools,
        configOverlayPaths: guestArgs?.configOverlayPaths,
        extensionPaths: guestArgs?.extensionPaths,
      }),
      profile.name,
    );

  // Resolve idle-timeout for this run: scope override (on SessionEntry) wins
  // over global default (preferences). 0 / undefined = no watchdog.
  const scopeOverride = sessions.getIdleTimeoutMinutes(scope);
  const idleTimeoutMs =
    scopeOverride !== undefined
      ? scopeOverride > 0
        ? scopeOverride * 60_000
        : undefined
      : getRunIdleTimeoutMs(controls.cfg);
  if (idleTimeoutMs) {
    log.info('flush', 'idle-watchdog', { idleTimeoutMs });
  }

  const replyMode = getMessageReplyMode(controls.cfg);
  log.info('flush', 'reply-mode', { mode: replyMode });

  // Re-read prefs on every flush so toggling /config mid-stream takes
  // effect immediately. Cheap object lookups, no allocation when on.
  const filterForPrefs = (state: RunState): RunState => {
    if (getShowToolCalls(controls.cfg)) return state;
    return { ...state, blocks: state.blocks.filter((b) => b.kind !== 'tool') };
  };

  // Thread the reply so it lands in the same thread as the user's message —
  // whenever the message carries a thread_id (topic groups AND thread-enabled
  // normal groups). Otherwise the SDK posts at top level and the user's thread
  // discussion breaks visually.
  const sendOpts = {
    replyTo: lastMsg.messageId,
    ...(threadId ? { replyInThread: true } : {}),
  };

  const uiCards = new Map<string, { messageId: string; title: string }>();
  const uiHooks: AgentStreamHooks = {
    async onUiRequest(request) {
      try {
        const existing = uiCards.get(request.id);
        if (existing) {
          await updateManagedCard(channel, existing.messageId, renderOmpUiRequestCard(request, scope));
          existing.title = request.title;
          return;
        }
        const sent = await sendManagedCard(channel, chatId, renderOmpUiRequestCard(request, scope), lastMsg.messageId);
        uiCards.set(request.id, { messageId: sent.messageId, title: request.title });
      } catch (err) {
        log.fail('omp-ui', err, { scope, requestId: request.id, method: request.method });
      }
    },
    async onUiCancel(targetId) {
      const entry = uiCards.get(targetId);
      if (!entry) return;
      try {
        await updateManagedCard(channel, entry.messageId, renderOmpUiResultCard(entry.title, 'cancelled'));
      } catch (err) {
        log.fail('omp-ui', err, { scope, requestId: targetId, step: 'cancel-update' });
      }
    },
  };

  // Run the agent into `flush`. If omp aborts because the session we asked it
  // to resume no longer exists, clear the stored session and retry ONCE with a
  // fresh session into the same card — so a stale/pruned session self-heals
  // instead of leaving the chat stuck on every subsequent message.
  const driveAgent = async (flush: (state: RunState) => Promise<void>): Promise<void> => {
    let handle = spawnHandle(resumeFrom);
    try {
      const { sessionNotFound } = await processAgentStream(
        handle, sessions, scope, cwd, profile.name, runInitialState, idleTimeoutMs, resumeFrom !== undefined, flush, uiHooks,
      );
      if (sessionNotFound && resumeFrom) {
        log.warn('session', 'resume-miss-retry', { sessionId: resumeFrom });
        sessions.clearProfile(scope, profile.name);
        activeRuns.unregister(scope, handle.run);
        handle = spawnHandle(undefined);
        // Fresh retry: not recoverable, so a (very unlikely) repeat error
        // renders normally and the card always reaches a terminal state.
        await processAgentStream(handle, sessions, scope, cwd, profile.name, runInitialState, idleTimeoutMs, false, flush, uiHooks);
      }
    } finally {
      activeRuns.unregister(scope, handle.run);
    }
  };

  // For non-card modes OMP's output doesn't surface visually until either
  // a first streamed token (markdown mode) or the whole run ends (text mode).
  // Add a "Typing" reaction to the triggering message as an instant ack;
  // remove it in finally. Card mode has a visible "正在思考…" footer the
  // moment the initial card lands, so the extra reaction would be redundant.
  const reactionId =
    replyMode === 'card' ? undefined : await addReaction(channel, lastMsg.messageId);

  try {
    if (replyMode === 'card') {
      await channel.stream(
        chatId,
        {
          card: {
            initial: renderCard(runInitialState),
            producer: async (ctrl) => {
              await driveAgent(async (state) => {
                await ctrl.update(renderCard(filterForPrefs(state)));
              });
            },
          },
        },
        sendOpts,
      );
    } else if (replyMode === 'markdown') {
      await channel.stream(
        chatId,
        {
          markdown: async (ctrl) => {
            await driveAgent(async (state) => {
              await ctrl.setContent(renderText(filterForPrefs(state)));
            });
          },
        },
        sendOpts,
      );
    } else {
      // text mode: drain the agent stream without sending anything during
      // the run, then post the final rendered text once as a plain markdown
      // (msg_type=post) message — no card, no streaming, no typewriter.
      let finalState: RunState = runInitialState;
      await driveAgent(async (state) => {
        finalState = state;
      });
      const body = renderText(filterForPrefs(finalState));
      if (body.trim()) {
        await channel.send(chatId, { markdown: body }, sendOpts);
      }
    }
  } catch (err) {
    log.fail('stream', err);
  } finally {
    if (reactionId) {
      await removeReaction(channel, lastMsg.messageId, reactionId);
    }
  }
}

/**
 * Drive the agent's event stream into a stateful RunState, calling `flush`
 * on every state transition. Used by both card and markdown reply modes —
 * the only difference between the two is what `flush` does with the state.
 */
async function processAgentStream(
  handle: RunHandle,
  sessions: SessionStore,
  scope: string,
  cwd: string,
  /** Profile name this run was spawned with — the session is stored under
   * (scope, profile) so a lower-privilege run never resumes a `full` thread. */
  profileName: string,
  /** Run-start state (carries the profile/owner badge), used as the seed so the
   * card header is present from the first frame. */
  initial: RunState,
  idleTimeoutMs: number | undefined,
  // Only the first, resumed attempt may swallow a "session not found" abort for
  // the caller to retry fresh. A fresh attempt renders the error normally so it
  // can never leave the card stuck non-terminal.
  recoverSessionMiss: boolean,
  flush: (state: RunState) => Promise<void>,
  hooks?: AgentStreamHooks,
): Promise<{ sessionNotFound: boolean }> {
  let state: RunState = initial;
  // Set when omp aborts because the session we asked it to --resume is gone.
  // The caller clears the stored session and retries with a fresh one; we do
  // NOT reduce this into a terminal error so the retry can continue into the
  // same card without a flash of "error".
  let sessionNotFound = false;

  // Idle watchdog: OMP going silent for `idleTimeoutMs` is treated as
  // "presumed hung", we stop() and surface a timeout marker on the card.
  //
  // BUT — OMP can legitimately be silent for a long time when it's
  // waiting on a long-running tool call (e.g. `lark-cli` printing an
  // OAuth URL and blocking until the user clicks authorize) or on an OMP
  // native UI prompt that the user must answer from a Feishu card.
  // Pause the watchdog while either a tool or UI request is in flight.
  //
  // The watchdog re-arms when:
  //  - a tool_result drains the in-flight set to zero, OR
  //  - any non-tool event arrives while the set is empty.
  let idleFired = false;
  let timer: NodeJS.Timeout | undefined;
  const inFlightTools = new Set<string>();
  const armOrPauseIdle = (): void => {
    if (!idleTimeoutMs) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (inFlightTools.size > 0 || handle.pendingUiRequests.size > 0) return;
    timer = setTimeout(() => {
      idleFired = true;
      handle.interrupted = true;
      log.warn('agent', 'idle-timeout', { scope, idleTimeoutMs });
      void handle.run.stop().catch(() => {
        /* stop errors are non-fatal */
      });
    }, idleTimeoutMs);
  };
  handle.onUiSettled = armOrPauseIdle;
  armOrPauseIdle();

  try {
    for await (const evt of handle.run.events) {
      if (handle.interrupted) break;

      // Track tool/UI flight before re-arming the idle timer so the arm step
      // sees the correct set size. tool_use/ui_request open a window;
      // tool_result/ui response/cancel closes it.
      if (evt.type === 'tool_use') {
        inFlightTools.add(evt.id);
        log.info('agent', 'tool-in-flight', {
          tool: evt.name,
          inFlight: inFlightTools.size,
        });
      } else if (evt.type === 'tool_result') {
        inFlightTools.delete(evt.id);
        log.info('agent', 'tool-done', { inFlight: inFlightTools.size });
      } else if (evt.type === 'ui_request') {
        handle.pendingUiRequests.add(evt.request.id);
        log.info('agent', 'ui-in-flight', { method: evt.request.method, inFlight: handle.pendingUiRequests.size });
      } else if (evt.type === 'ui_cancel') {
        handle.pendingUiRequests.delete(evt.targetId);
        log.info('agent', 'ui-cancelled', { inFlight: handle.pendingUiRequests.size });
      }
      armOrPauseIdle();

      if (evt.type === 'system') {
        if (evt.sessionId) {
          const effectiveCwd = evt.cwd ?? cwd;
          sessions.set(scope, evt.sessionId, effectiveCwd, profileName);
          log.info('session', 'set', { sessionId: evt.sessionId, profile: profileName });
        }
        continue;
      }
      if (evt.type === 'usage') {
        if (evt.costUsd !== undefined) {
          log.info('agent', 'usage', { costUsd: Number(evt.costUsd.toFixed(4)) });
        }
        continue;
      }
      if (evt.type === 'ui_request') {
        await hooks?.onUiRequest(evt.request);
      } else if (evt.type === 'ui_cancel') {
        await hooks?.onUiCancel(evt.targetId);
      }

      if (recoverSessionMiss && evt.type === 'error' && isSessionMissingError(evt.message)) {
        sessionNotFound = true;
        log.warn('session', 'resume-missing', { scope });
        break;
      }

      const prevTerminal = state.terminal;
      const prevFooter = state.footer;
      state = reduce(state, evt);
      if (state.footer !== prevFooter || state.terminal !== prevTerminal) {
        log.info('card', 'transition', { footer: state.footer, terminal: state.terminal });
      }
      await flush(state);
      // Stop iterating as soon as we have a terminal state. Some OMP
      // RPC runs may leave stdout open briefly after agent_end, which
      // would leave the for-await waiting forever otherwise.
      if (state.terminal !== 'running') break;
    }
  } finally {
    if (handle.onUiSettled === armOrPauseIdle) handle.onUiSettled = undefined;
    if (timer) clearTimeout(timer);
  }

  // Recoverable resume-miss: leave the card non-terminal — the caller clears
  // the stored session and retries with a fresh one into the same card — but
  // still reap the dead child here.
  if (sessionNotFound) {
    await reapRun(handle);
    return { sessionNotFound: true };
  }

  // If state already reached a terminal event (done/error/etc.) before the
  // watchdog or interrupt could land, don't clobber it — that real terminal
  // wins. This avoids "OMP finished but flush was slow → timer fired
  // mid-flush → user sees 'idle_timeout' on a successful run".
  if (state.terminal === 'running') {
    if (idleFired) {
      state = markIdleTimeout(state, Math.round(idleTimeoutMs! / 60_000));
    } else if (handle.interrupted) {
      state = markInterrupted(state);
    } else {
      state = finalizeIfRunning(state);
    }
  }
  log.info('card', 'final', { terminal: state.terminal, interrupted: handle.interrupted });
  await flush(state);
  await reapRun(handle);
  return { sessionNotFound: false };
}

/**
 * Reap the agent subprocess after a run ends. Two regimes:
 *  - Interrupted (user /stop, idle watchdog, disconnect): stop() was already
 *    fire-and-forgotten by whoever set handle.interrupted; this awaits it.
 *  - Natural done: agent_end can arrive before OMP has fully closed stdout.
 *    Wait it out so the run exits with code 0; only SIGTERM as a safety net.
 */
async function reapRun(handle: RunHandle): Promise<void> {
  if (handle.interrupted) {
    await handle.run.stop();
  } else {
    const exited = await handle.run.waitForExit(POST_DONE_EXIT_GRACE_MS);
    if (!exited) {
      log.warn('agent', 'post-done-timeout', { graceMs: POST_DONE_EXIT_GRACE_MS });
      await handle.run.stop();
    }
  }
}

/**
 * How long to wait for OMP to close stdout after a terminal event before
 * forcing a SIGTERM. Empirically OMP's post-agent_end tail is well under a
 * second; 2s leaves headroom for slow flushes without making the user notice
 * a stall (the card has already rendered terminal state by this point).
 */
const POST_DONE_EXIT_GRACE_MS = 2000;

/**
 * For interactive-card messages the SDK flattens to text-bearing nodes or
 * the literal "[interactive card]" placeholder, losing v2 `user_dsl` and the
 * raw v1 JSON. Pull the raw webhook content (attached via `includeRawEvent`)
 * and feed it to `expandInteractiveCard` so direct-receive cards get the
 * same `<interactive_card>` injection that quoted cards already get.
 */
function expandedMessageContent(m: NormalizedMessage): string {
  if (m.rawContentType !== 'interactive') return m.content;
  const rawContent = (m.raw as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof rawContent !== 'string') return m.content;
  return expandInteractiveCard(m.content, rawContent);
}

function buildPrompt(
  batch: NormalizedMessage[],
  attachments: LocalAttachment[],
  quotes: QuotedContext[] = [],
): string {
  const fileKeys = batch.flatMap((m) => m.resources.map((r) => r.fileKey));
  const texts = batch
    .map((m) => stripAttachmentRefs(expandedMessageContent(m), fileKeys).trim())
    .filter(Boolean);
  const ctxHeader = buildBridgeContextHeader(batch);
  const quoteBlock = renderQuotedBlock(quotes);

  // Order: <bridge_context> (metadata) → <quoted_message>(s) (what user is
  // pointing at) → user text + attachments (what they're asking).
  const prefixParts = [ctxHeader, quoteBlock].filter(Boolean);
  const prefix = prefixParts.length > 0 ? `${prefixParts.join('\n\n')}\n\n` : '';

  if (attachments.length === 0) {
    return `${prefix}${texts.join('\n\n')}`;
  }

  const attachLines = attachments.map((a) => {
    const label =
      a.kind === 'image'
        ? '图片'
        : a.kind === 'audio'
          ? '音频'
          : a.kind === 'video'
            ? '视频'
            : '文件';
    const name = a.originalName ? ` (${a.originalName})` : '';
    return `- ${a.path}${name} — ${label}`;
  });
  const userPart = texts.length > 0 ? texts.join('\n\n') : '请看下面的附件。';
  return `${prefix}${userPart}\n\n附件（本地路径）：\n${attachLines.join('\n')}`;
}

function buildBridgeContextHeader(batch: NormalizedMessage[]): string {
  const m = batch[0];
  if (!m) return '';
  const lines = [
    '<bridge_context>',
    `chat_id: ${m.chatId}`,
    `chat_type: ${m.chatType}`,
    `sender_id: ${m.senderId}`,
  ];
  if (m.senderName) lines.push(`sender_name: ${m.senderName}`);
  if (m.threadId) lines.push(`thread_id: ${m.threadId}`);
  lines.push('</bridge_context>');
  return lines.join('\n');
}

function stripAttachmentRefs(text: string, fileKeys: string[]): string {
  if (!text || fileKeys.length === 0) return text;
  let out = text;
  for (const key of fileKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), '');
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

