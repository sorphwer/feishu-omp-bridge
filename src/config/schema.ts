import { paths } from './paths';

export type TenantBrand = 'feishu' | 'lark';

/**
 * SecretRef points at a secret stored outside this file — keeps secrets out
 * of `config.json` so backups / accidental git commits / log dumps don't
 * leak the bot's App Secret. Mirrors openclaw / lark-cli's `SecretRef`
 * shape so lark-cli's `--source lark-channel` reads it through the same
 * generic `ResolveSecretInput` pipeline as openclaw.
 *
 *   - `env`:  value is in process env at `id` (optionally allowlisted via provider)
 *   - `file`: value is at the path `id` (or `provider.path` if provider config)
 *   - `exec`: spawn `provider.command`, send JSON over stdin, read JSON from stdout
 */
export interface SecretRef {
  source: 'env' | 'file' | 'exec';
  provider?: string;
  id: string;
}

/** A secret field can be either a plain string (potentially a `${VAR}`
 * template) or a SecretRef. JSON deserializer accepts both forms. */
export type SecretInput = string | SecretRef;

export interface AppCredentials {
  id: string;
  secret: SecretInput;
  tenant: TenantBrand;
}

/**
 * `secrets.providers` is openclaw-compatible: each named provider declares
 * how SecretRefs resolve to plaintext (env allowlist, file path, exec
 * command). Only the fields actually consumed by bridge's resolver are
 * typed here; lark-cli reads the same JSON via its richer Go types.
 */
export interface ProviderConfig {
  source: 'env' | 'file' | 'exec';
  /** env: allowlist of env var names that ref.id is allowed to be in. */
  allowlist?: string[];
  /** file: optional base path; ref.id is joined onto it. */
  path?: string;
  /** exec: command to spawn + args. */
  command?: string;
  args?: string[];
  /** exec: explicit env to inject (key=value pairs). */
  env?: Record<string, string>;
  /** exec: env var names to pass through from parent env. */
  passEnv?: string[];
  /** exec: max ms to wait for the child. */
  noOutputTimeoutMs?: number;
  /** exec: max stdout bytes accepted before treating as runaway. */
  maxOutputBytes?: number;
}

export interface SecretsConfig {
  providers?: Record<string, ProviderConfig>;
  defaults?: { env?: string; file?: string; exec?: string };
}

/**
 * How replies are rendered in IM chats:
 *   - `card`: full interactive card (tool panels, ⏹ button, footer status)
 *   - `markdown`: lightweight streaming markdown card (typewriter, no buttons)
 *   - `text`: plain markdown post sent once at run completion (no streaming)
 *
 * Pre-0.1.27 only had `card` and `text`, where `text` meant what's now called
 * `markdown`. See `messageReplyMigrated` for the auto-coercion logic.
 */
export type MessageReplyMode = 'card' | 'markdown' | 'text';

/**
 * Access control settings. All three lists default to "no restriction" when
 * empty / undefined, so existing deployments are not broken on upgrade.
 * Operators that want a hardened deployment fill these in via
 * `~/.feishu-omp-bridge/config.json` (no CLI surface yet — by design, since
 * persisting the lists requires the operator to look up open_ids/chat_ids
 * out-of-band anyway).
 */
export interface AppAccess {
  /** open_id whitelist for who can interact with the bot (DM + group @bot).
   * Empty/undefined = allow everyone. */
  allowedUsers?: string[];
  /** chat_id whitelist for chats the bot responds in. Empty/undefined =
   * respond in all chats it's invited to. */
  allowedChats?: string[];
  /** open_id list with admin privileges. Gates sensitive commands
   * (/account, /config, /exit, /reconnect, /doctor, /cd, /ws). Empty /
   * undefined = no admin restriction (every allowed user is an admin). */
  admins?: string[];
}

/**
 * Declares a local CLI that the agent may invoke as a host tool. The bridge
 * spawns `command` directly (argv array, NEVER a shell), so the model can
 * only run THIS binary with argument tokens — no pipes, redirection,
 * globbing, command chaining, or substitution. `allowedSubcommands`, when
 * set, additionally pins the first argument to a known-safe set.
 */
export interface CommandToolConfig {
  /** Tool name exposed to the agent. Must match /^[a-zA-Z0-9_]+$/. */
  name: string;
  /** Executable to spawn (PATH lookup or absolute path). */
  command: string;
  /** Fixed leading args always prepended before model-supplied args. */
  args?: string[];
  /** Fixed trailing args always appended after model-supplied args (e.g. `-o json`). */
  appendArgs?: string[];
  /** Allowlist for the first model-supplied arg (the subcommand). Empty/unset = any. */
  allowedSubcommands?: string[];
  /** Description shown to the model. */
  description?: string;
  /** Working directory; defaults to the run cwd. */
  cwd?: string;
  /** Hard timeout in ms. Default 120000, clamped [1000, 600000]. */
  timeoutMs?: number;
  /** Max output bytes returned to the model. Default 30000, clamped [1000, 200000]. */
  maxOutputBytes?: number;
  /** Max times this tool may be called per run (turn). Unset = no per-tool cap. */
  maxCalls?: number;
}

/**
 * Sandboxes NON-trusted senders. When present, any sender NOT in
 * `unrestrictedUsers` runs OMP with a hard tool allowlist (a fail-closed
 * `tool_call` hook), discovery sources disabled, and only the declared
 * `commandTools` available — so a stranger DMing the bot can drive only the
 * whitelisted CLIs, never bash / eval / MCP / file tools. Trusted senders
 * (the operator) are completely unaffected and keep the full tool set.
 *
 * Absent = feature off: everyone gets the normal full tool set (back-compat).
 */
export interface GuestToolPolicy {
  /** Senders exempt from the sandbox (full tools). Falls back to `access.admins` when unset. */
  unrestrictedUsers?: string[];
  /** CLIs exposed to guests as host tools (their only execution surface). */
  commandTools?: CommandToolConfig[];
  /** Extra builtin tool names guests may also call (e.g. "read"). Default: none. */
  extraToolAllowlist?: string[];
  /** Expose the Feishu host tools (send/reply/get message) to guests. Default false. */
  feishuHostTools?: boolean;
  /** Total tool calls allowed per run (turn) across ALL tools. Unset/0 = no total cap. */
  maxToolCalls?: number;
  /**
   * System-prompt text PREPENDED to the guest user prompt — gives the
   * sandboxed agent its role/instructions without affecting trusted users.
   * Empty/unset = none. (Prepended, not `--append-system-prompt`, which hung
   * the codex request.)
   */
  systemPrompt?: string;
}

export interface AppPreferences {
  /** OMP executable name or path. Default: omp. */
  ompBinary?: string;
  /** Optional OMP model passed as `--model`. Empty means OMP config decides. */
  ompModel?: string;
  /** Optional OMP thinking level passed as `--thinking`. */
  ompThinking?: string;
  /** Optional OMP session directory. Defaults to the bridge-owned session dir. */
  ompSessionDir?: string;
  /** Optional comma-separated OMP tool allowlist passed as `--tools`. */
  ompTools?: string;
  /** Legacy Codex executable name or path. Used only when `ompBinary` is absent. */
  codexBinary?: string;
  /** Legacy Codex model. Used only when `ompModel` is absent. */
  codexModel?: string;
  /** Reply rendering mode for IM (group/p2p) messages. Default 'card'. */
  messageReply?: MessageReplyMode;
  /**
   * Internal marker: pre-0.1.27 the value `'text'` meant "lightweight
   * streaming markdown card" (what's now called `'markdown'`). On upgrade
   * we'd silently switch those users to true plain-text behavior unless we
   * coerce; this flag is set the first time the user submits `/config`
   * after the rename, indicating their `messageReply` value is in the
   * new semantic.
   */
  messageReplyMigrated?: boolean;
  /**
   * Whether to render tool-call blocks (Bash / Read / Edit / ...) in the
   * output. Default true. Turn off if you only care about OMP's final
   * text answer and want to hide the "工具调用过程".
   */
  showToolCalls?: boolean;
  /**
   * Cap on concurrent OMP runs across all chats / topics. Excess runs
   * queue FIFO. Default 10. Mostly relevant for topic groups where each
   * topic can spawn its own run; capping protects RAM / token spend.
   */
  maxConcurrentRuns?: number;
  /**
   * Global default idle-timeout for OMP runs, in minutes. When set,
   * if OMP emits no stream event for this long the bridge kills the
   * run as presumed-hung. Undefined / 0 = no timeout (the default — runs
   * can hang indefinitely). Per-scope `/timeout` overrides this.
   */
  runIdleTimeoutMinutes?: number;
  /**
   * Whether the bot only responds to messages that @-mention it in groups
   * (regular and topic groups). p2p is always unrestricted. Default true:
   * groups are quiet unless the user @bot. Set false to let any group
   * message reach OMP (the 0.1.21-and-earlier behavior).
   *
   * @全员 is never responded to regardless (SDK `respondToMentionAll: false`).
   * Cloud-doc comments still require @-mention unconditionally.
   */
  requireMentionInGroup?: boolean;
  /** Access control — user/chat allowlists + admin gating. See AppAccess. */
  access?: AppAccess;
  /** Per-sender tool sandbox for non-trusted senders. See GuestToolPolicy. */
  guestPolicy?: GuestToolPolicy;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when killing the OMP
   * subprocess. Bumped from a hardcoded 500ms because agents often have
   * their own subprocesses (e.g. lark-cli mid-OAuth) that need a moment to clean
   * up — too short a window and the SIGKILL cascade kills the descendants
   * before they can finish what the user is waiting on. Default 5000ms.
   * Range 100-30000; out-of-range values fall back to default.
   */
  agentStopGraceMs?: number;
}

export type RelayRole = 'front' | 'worker';

/**
 * Relay lets one bridge (a `front`, holding the single Feishu long-connection)
 * forward events to another bridge (a `worker`, e.g. your laptop) that runs the
 * agent and replies to Feishu itself. Absent = standalone (the default, single
 * bridge). See src/relay for the transport.
 *
 * Auth needs NO extra secret: both sides already share the same app, so the
 * relay handshake is HMAC'd with a key derived from the App Secret.
 */
export interface RelayConfig {
  role: RelayRole;
  /**
   * `front`: HTTP bind address for the relay server (`host:port`). Workers
   * dial in over SSE. Default `127.0.0.1:8787` (front it with a TLS reverse
   * proxy, or set `0.0.0.0:<port>` — the HMAC handshake is the access gate).
   */
  listen?: string;
  /**
   * `worker`: base URL of the front's relay server, e.g.
   * `https://your-server.example`. The ONE field a worker must set.
   */
  endpoint?: string;
  /**
   * `front`: which senders (open_id) are relayed to a worker. Falls back to a
   * non-empty `guestPolicy.unrestrictedUsers`, then non-empty `access.admins`.
   * Empty/unset everywhere = relay NOBODY (fail-safe — never relay strangers
   * to your laptop). Untrusted senders stay on the front (guest sandbox).
   */
  route?: { users?: string[] };
  /** Stable id for this worker (shown in logs; multi-worker future). Default: hostname. */
  workerId?: string;
  /**
   * Optional relay-auth secret. When set, BOTH sides derive the relay HMAC key
   * from it instead of the App Secret — lets you rotate/revoke relay access
   * independently of the Feishu credential, and decouples "can connect to the
   * relay" from "can act as the bot". Front and worker MUST agree (both set to
   * the same value, or both unset). Unset = derive from the App Secret
   * (zero-config default). Accepts the same forms as the app secret
   * (plain / `${ENV}` / keystore ref).
   */
  secret?: SecretInput;
}

/**
 * Top-level config shape on disk.
 *
 * `accounts` is a namespace for credential-flavored fields (currently just
 * the bot app, room for OAuth / alternate apps later). `preferences`
 * holds user-tunable behavior knobs. Other future sections (mcp, etc.)
 * belong at this top level alongside them.
 */
export interface AppConfig {
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences?: AppPreferences;
  relay?: RelayConfig;
}

export function isComplete(cfg: Partial<AppConfig>): cfg is AppConfig {
  const app = cfg.accounts?.app;
  return Boolean(app?.id && hasSecret(app?.secret) && app?.tenant);
}

function hasSecret(s: SecretInput | undefined): boolean {
  if (!s) return false;
  if (typeof s === 'string') return s.length > 0;
  return Boolean(s.source && s.id);
}

/** True iff this credential's secret is stored externally (env/file/exec). */
export function isSecretRef(s: SecretInput): s is SecretRef {
  return typeof s === 'object' && s !== null;
}

/** Account/keystore key for the bot's App Secret. lark-cli also uses a
 * similar `appsecret:` convention so audit/grep is consistent. */
export function secretKeyForApp(appId: string): string {
  return `app-${appId}`;
}

/**
 * Resolve the message-reply preference with default fallback + legacy coerce.
 *
 * Pre-0.1.27 users with `messageReply: 'text'` actually wanted the streaming
 * markdown card (the new `'markdown'`). Until they re-submit `/config`
 * (which sets `messageReplyMigrated: true`), we map their `text` →
 * `markdown` so the behavior stays the same after upgrade.
 *
 * Default for fresh configs (no `messageReply` set) is `'markdown'`.
 */
export function getOmpBinary(cfg: AppConfig): string {
  const raw = cfg.preferences?.ompBinary ?? cfg.preferences?.codexBinary;
  if (typeof raw !== 'string' || raw.trim() === '') return 'omp';
  return raw.trim();
}

export function getOmpModel(cfg: AppConfig): string | undefined {
  const raw = cfg.preferences?.ompModel ?? cfg.preferences?.codexModel;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return raw.trim();
}

export function getOmpThinking(cfg: AppConfig): string | undefined {
  const raw = cfg.preferences?.ompThinking;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return raw.trim();
}

export function getOmpSessionDir(cfg: AppConfig): string {
  const raw = cfg.preferences?.ompSessionDir;
  if (typeof raw !== 'string' || raw.trim() === '') return paths.ompSessionsDir;
  return raw.trim();
}

export function getOmpTools(cfg: AppConfig): string | undefined {
  const raw = cfg.preferences?.ompTools;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return raw.trim();
}

export function getMessageReplyMode(cfg: AppConfig): MessageReplyMode {
  const raw = cfg.preferences?.messageReply;
  if (raw === 'text' && cfg.preferences?.messageReplyMigrated !== true) {
    return 'markdown';
  }
  if (raw === 'card' || raw === 'markdown' || raw === 'text') return raw;
  return 'markdown';
}

/** Resolve the show-tool-calls preference with default fallback. */
export function getShowToolCalls(cfg: AppConfig): boolean {
  return cfg.preferences?.showToolCalls !== false;
}

/** Resolve the max-concurrent-runs preference with default + sanity clamp. */
export function getMaxConcurrentRuns(cfg: AppConfig): number {
  const raw = cfg.preferences?.maxConcurrentRuns;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 10;
  // Reasonable upper bound — at 50+ concurrent OMP processes the bot box is
  // probably already RAM-starved. Clamp to keep typos from killing the box.
  return Math.min(Math.floor(raw), 50);
}

/**
 * Resolve the require-mention-in-group preference. Default `true` — the
 * `!== false` check makes "undefined" (older configs that don't have the
 * field) inherit the new safer default automatically.
 */
export function getRequireMentionInGroup(cfg: AppConfig): boolean {
  return cfg.preferences?.requireMentionInGroup !== false;
}

/**
 * Resolve the global default idle-timeout in ms. Returns `undefined` when
 * disabled (the default). Clamps to [1, 120] minutes when set so a typo
 * can't lock the bot into a 1-second kill loop or wait forever to a number
 * the user didn't really mean.
 */
/**
 * Grace period before SIGKILL fallback when stopping an OMP subprocess.
 * Returns ms. Defaults to 5000 (5 seconds). Clamps to [100, 30000] so a
 * typo can't either make stop() effectively SIGKILL-immediate or hang for
 * minutes.
 */
export function getAgentStopGraceMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.agentStopGraceMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5000;
  return Math.min(30_000, Math.max(100, Math.floor(raw)));
}

/** True when `senderId` may interact with the bot. Empty list = allow all. */
export function isUserAllowed(cfg: AppConfig, senderId: string): boolean {
  const list = cfg.preferences?.access?.allowedUsers;
  if (!list || list.length === 0) return true;
  return list.includes(senderId);
}

/** True when `chatId` is one the bot will respond in. Empty list = allow all. */
export function isChatAllowed(cfg: AppConfig, chatId: string): boolean {
  const list = cfg.preferences?.access?.allowedChats;
  if (!list || list.length === 0) return true;
  return list.includes(chatId);
}

/** True when `senderId` has admin privileges. Empty list = no admin
 * restriction (every allowed user can run admin commands). */
export function isAdmin(cfg: AppConfig, senderId: string): boolean {
  const list = cfg.preferences?.access?.admins;
  if (!list || list.length === 0) return true;
  return list.includes(senderId);
}

export function getRunIdleTimeoutMs(cfg: AppConfig): number | undefined {
  const raw = cfg.preferences?.runIdleTimeoutMinutes;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  const clamped = Math.min(Math.max(Math.floor(raw), 1), 120);
  return clamped * 60_000;
}

/**
 * The guest sandbox policy, or undefined when the feature is off. When
 * present, senders not on the trusted list run OMP in a hard-allowlisted
 * sandbox (see GuestToolPolicy).
 */
export function getGuestPolicy(cfg: AppConfig): GuestToolPolicy | undefined {
  const p = cfg.preferences?.guestPolicy;
  return p && typeof p === 'object' ? p : undefined;
}

/**
 * True when `senderId` is NOT sandboxed: either the feature is off, or the
 * sender is on the trusted exemption list. Trusted list falls back to
 * `access.admins` when `unrestrictedUsers` is unset. When a policy is present
 * but no trusted list resolves, nobody is exempt (fail-safe: lock rather than
 * silently exempt everyone). Equivalently, `!isUnrestrictedUser(...)` means
 * "apply the guest sandbox to this sender".
 */
export function isUnrestrictedUser(cfg: AppConfig, senderId: string): boolean {
  const policy = getGuestPolicy(cfg);
  if (!policy) return true;
  const list = policy.unrestrictedUsers ?? cfg.preferences?.access?.admins;
  if (!list || list.length === 0) return false;
  return list.includes(senderId);
}

/** The relay config, or undefined when relay is off (standalone bridge). */
export function getRelayConfig(cfg: AppConfig): RelayConfig | undefined {
  return cfg.relay;
}

/**
 * The open_id set the front relays to a worker. Explicit `relay.route.users`
 * wins; otherwise falls back to a NON-EMPTY `unrestrictedUsers`, then NON-EMPTY
 * `admins`. Empty everywhere = relay nobody (fail-safe: an unset trust list
 * must never mean "relay everyone to the laptop").
 */
export function relayTrustedUsers(cfg: AppConfig): string[] {
  const route = cfg.relay?.route?.users?.filter(Boolean);
  if (route && route.length > 0) return route;
  const unrestricted = cfg.preferences?.guestPolicy?.unrestrictedUsers?.filter(Boolean);
  if (unrestricted && unrestricted.length > 0) return unrestricted;
  const admins = cfg.preferences?.access?.admins?.filter(Boolean);
  if (admins && admins.length > 0) return admins;
  return [];
}

/** True when `senderId` should be relayed to a worker (and is non-empty). */
export function isRelayTrusted(cfg: AppConfig, senderId: string | undefined): boolean {
  if (!senderId) return false;
  return relayTrustedUsers(cfg).includes(senderId);
}

const TOOL_NAME_RE = /^[a-zA-Z0-9_]+$/;

function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === 'string');
  return arr.length > 0 ? arr : undefined;
}

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

/**
 * Validated guest command-tool configs: drops entries with an invalid name
 * (must match /^[a-zA-Z0-9_]+$/) or empty command, dedupes by name, and
 * fills timeout/output defaults.
 */
export function getGuestCommandTools(cfg: AppConfig): CommandToolConfig[] {
  const raw: unknown = getGuestPolicy(cfg)?.commandTools;
  if (!Array.isArray(raw)) return [];
  const out: CommandToolConfig[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    const command = typeof e.command === 'string' ? e.command.trim() : '';
    if (!TOOL_NAME_RE.test(name) || command === '' || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      command,
      args: toStringArray(e.args),
      appendArgs: toStringArray(e.appendArgs),
      allowedSubcommands: toStringArray(e.allowedSubcommands),
      description: typeof e.description === 'string' && e.description.trim() !== '' ? e.description.trim() : undefined,
      cwd: typeof e.cwd === 'string' && e.cwd.trim() !== '' ? e.cwd.trim() : undefined,
      timeoutMs: clampInt(e.timeoutMs, 120_000, 1000, 600_000),
      maxOutputBytes: clampInt(e.maxOutputBytes, 30_000, 1000, 200_000),
      maxCalls:
        typeof e.maxCalls === 'number' && Number.isFinite(e.maxCalls) && e.maxCalls > 0
          ? Math.floor(e.maxCalls)
          : undefined,
    });
  }
  return out;
}

/**
 * The hard allowlist of tool names a guest may call: command-tool names plus
 * any `extraToolAllowlist` entries (deduped). Enforced by the guest hook.
 */
export function getGuestToolAllowlist(cfg: AppConfig): string[] {
  const policy = getGuestPolicy(cfg);
  if (!policy) return [];
  const names = getGuestCommandTools(cfg).map((t) => t.name);
  const extra = Array.isArray(policy.extraToolAllowlist)
    ? policy.extraToolAllowlist.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
    : [];
  return [...new Set([...names, ...extra])];
}

/** Whether guests may use the Feishu host tools. Default false. */
export function getGuestFeishuHostTools(cfg: AppConfig): boolean {
  return getGuestPolicy(cfg)?.feishuHostTools === true;
}

/** Guest-only system prompt to append, or undefined when unset/blank. */
export function getGuestSystemPrompt(cfg: AppConfig): string | undefined {
  const raw = getGuestPolicy(cfg)?.systemPrompt;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return raw;
}

/** Per-run (per-turn) tool-call caps enforced by the guest hook. */
export interface GuestToolLimits {
  /** Total tool calls allowed across all tools. 0 = no total cap. */
  maxTotal: number;
  /** Per-tool-name caps. Absent name = no per-tool cap. */
  perTool: Record<string, number>;
}

/** Resolve guest tool-call caps from policy (total + per-command-tool). */
export function getGuestToolLimits(cfg: AppConfig): GuestToolLimits {
  const raw = getGuestPolicy(cfg)?.maxToolCalls;
  const maxTotal =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  const perTool: Record<string, number> = {};
  for (const t of getGuestCommandTools(cfg)) {
    if (typeof t.maxCalls === 'number') perTool[t.name] = t.maxCalls;
  }
  return { maxTotal, perTool };
}
