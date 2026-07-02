import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { log } from '../core/logger';
import { paths } from './paths';
import {
  normalizeCommandTools,
  type AppConfig,
  type CommandToolConfig,
  type PolicyConfig,
  type PolicyRule,
  type PolicyRunTarget,
  type PolicyScenario,
  type PrincipalConfig,
  type PrincipalInput,
  type ProfileConfig,
} from './schema';

/**
 * ── Unified policy resolution ─────────────────────────────────────────────
 *
 * Turns an inbound event's (sender, scenario, chat) into the agent tool mode
 * (`ResolvedProfile`) it runs under and where it runs (`PolicyRunTarget`).
 *
 * `effectivePolicy(cfg)` is the single entry: it returns the explicit
 * `cfg.policy` when set, else falls back to a built-in open default (everyone
 * runs `full`, nothing relays). Everything downstream (channel.ts, route.ts)
 * consumes the resolved result, never raw legacy fields, so there is exactly
 * one place that understands the matrix.
 */

/** Reserved principal name for any sender not in a named principal. */
export const GUEST_PRINCIPAL = 'guest';

/** A fully-defaulted view of a profile, ready to apply to a run. */
export interface ResolvedProfile {
  /** Profile name (for logs); `locked` / `locked(<name>)` mark fail-closed. */
  name: string;
  /** false = the full built-in tool set, no sandbox. true = restricted sandbox. */
  restricted: boolean;
  /** Restricted only: built-in tools allowed (e.g. `['read','search']`). */
  builtinTools: string[];
  /** Host CLIs exposed to this profile. */
  commandTools: CommandToolConfig[];
  /** Whether the Feishu host tools are exposed. */
  feishuHostTools: boolean;
  /** OMP discovery sources (external MCP) enabled. */
  discovery: boolean;
  /** Shared memory (retain/recall/reflect) enabled. */
  memory: boolean;
  /** Total tool-call cap per run (restricted only). 0 = no cap. */
  maxToolCalls: number;
  /** System prompt prepended to the user prompt, or undefined. */
  systemPrompt?: string;
  /** Resolved paths to custom OMP extension files (`--extension`) for this profile. */
  extensions: string[];
}

export interface PolicyContext {
  senderId?: string;
  /** Scenario; undefined when unknown (e.g. card/comment routing). */
  chat?: PolicyScenario;
  chatId?: string;
}

/** Built-in `full`: the unrestricted tool set, no sandbox. */
const FULL_PROFILE: ResolvedProfile = {
  name: 'full',
  restricted: false,
  builtinTools: [],
  commandTools: [],
  feishuHostTools: true,
  discovery: true,
  memory: true,
  maxToolCalls: 0,
  extensions: [],
};

/** Built-in `locked`: fail-closed — zero tools, no host tools, nothing. */
const LOCKED_PROFILE: ResolvedProfile = {
  name: 'locked',
  restricted: true,
  builtinTools: [],
  commandTools: [],
  feishuHostTools: false,
  discovery: false,
  memory: false,
  maxToolCalls: 0,
  extensions: [],
};

function strNonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function cleanList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter(strNonEmpty).map((s) => s.trim()) : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Resolve a custom extension/hook path. `~` expands to home; relative paths
 * resolve against the STABLE config dir (`~/.feishu-omp-bridge`), never the
 * process/run cwd. Existence is NOT checked here — a missing limiter file must
 * fail the run loudly rather than silently disappear.
 */
function resolveExtensionPaths(v: unknown): string[] {
  return cleanList(v).map((p) => {
    if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(1));
    if (isAbsolute(p)) return p;
    return resolve(paths.appDir, p);
  });
}

const VALID_SCENARIOS: PolicyScenario[] = ['p2p', 'group', 'topic'];

/** Filtered scenario list, or `undefined` when the field is absent (= no
 * restriction). An explicit array that filters down to empty stays `[]`
 * (relay nothing) — distinct from absent. */
function normalizeScenarios(v: unknown): PolicyScenario[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return [...new Set(v.filter((s): s is PolicyScenario => VALID_SCENARIOS.includes(s as PolicyScenario)))];
}

/** True when `scenario` is covered by an `allowed` relay-scenario list. A
 * `group` allowance also covers `topic`. An unknown scenario (e.g. a doc
 * comment) never satisfies an explicit restriction. */
function scenarioMatches(allowed: PolicyScenario[], scenario: PolicyScenario | undefined): boolean {
  if (!scenario) return false;
  if (allowed.includes(scenario)) return true;
  return scenario === 'topic' && allowed.includes('group');
}

/** Coerce the shorthand (`string[]`) or full principal form to `PrincipalConfig`. */
export function normalizePrincipal(input: PrincipalInput | undefined): PrincipalConfig {
  if (Array.isArray(input)) return { users: cleanList(input), run: 'front' };
  const users = cleanList(input?.users);
  const run: PolicyRunTarget = input?.run === 'worker' ? 'worker' : 'front';
  const relayScenarios = normalizeScenarios(input?.relayScenarios);
  return relayScenarios !== undefined ? { users, run, relayScenarios } : { users, run };
}

/** The principal name a sender belongs to, or `guest`. */
export function principalOf(policy: PolicyConfig, senderId: string | undefined): string {
  if (!senderId) return GUEST_PRINCIPAL;
  for (const [name, raw] of Object.entries(policy.principals ?? {})) {
    if (name === GUEST_PRINCIPAL) continue;
    if (normalizePrincipal(raw).users.includes(senderId)) return name;
  }
  return GUEST_PRINCIPAL;
}

function runTargetForPrincipal(policy: PolicyConfig, principal: string): PolicyRunTarget {
  if (principal === GUEST_PRINCIPAL) return 'front';
  const raw = policy.principals?.[principal];
  return raw ? normalizePrincipal(raw).run ?? 'front' : 'front';
}

/** Resolve a profile name to a fully-defaulted `ResolvedProfile` (fail-closed on unknown). */
export function resolveProfile(
  name: string,
  profiles: Record<string, ProfileConfig> | undefined,
): ResolvedProfile {
  if (name === 'full') return FULL_PROFILE;
  if (name === 'locked') return LOCKED_PROFILE;
  const p = profiles?.[name];
  if (!p) {
    log.warn('policy', 'unknown-profile', { name });
    return { ...LOCKED_PROFILE, name: `locked(${name})` };
  }
  const systemPrompt = strNonEmpty(p.systemPrompt) ? p.systemPrompt : undefined;
  // `tools: 'all'` (or omitted) = full set, no sandbox. Discovery/memory/feishu
  // default ON for a full profile but may be turned off explicitly.
  if (p.tools === undefined || p.tools === 'all') {
    return {
      name,
      restricted: false,
      builtinTools: [],
      commandTools: normalizeCommandTools(p.commandTools),
      feishuHostTools: p.feishuHostTools !== false,
      discovery: p.discovery !== 'off',
      memory: p.memory !== 'off',
      maxToolCalls: 0,
      systemPrompt,
      extensions: resolveExtensionPaths(p.extensions),
    };
  }
  // Restricted sandbox: built-ins pinned to `tools`; discovery/memory default OFF.
  return {
    name,
    restricted: true,
    builtinTools: cleanList(p.tools),
    commandTools: normalizeCommandTools(p.commandTools),
    feishuHostTools: p.feishuHostTools === true,
    discovery: p.discovery === 'on',
    memory: p.memory === 'on',
    maxToolCalls:
      typeof p.maxToolCalls === 'number' && Number.isFinite(p.maxToolCalls) && p.maxToolCalls > 0
        ? Math.floor(p.maxToolCalls)
        : 0,
    systemPrompt,
    extensions: resolveExtensionPaths(p.extensions),
  };
}

function matchRule(rule: PolicyRule, principal: string, ctx: PolicyContext): boolean {
  const w = rule.when;
  if (!w) return true;
  if (w.principal !== undefined) {
    const ps = Array.isArray(w.principal) ? w.principal : [w.principal];
    if (!ps.includes(principal)) return false;
  }
  if (w.chat !== undefined) {
    // Scenario-constrained rule can't match when the scenario is unknown.
    if (ctx.chat === undefined) return false;
    const cs = Array.isArray(w.chat) ? w.chat : [w.chat];
    const ok = cs.some((c) => c === ctx.chat || (c === 'group' && ctx.chat === 'topic'));
    if (!ok) return false;
  }
  if (w.chatId !== undefined) {
    if (!ctx.chatId || !w.chatId.includes(ctx.chatId)) return false;
  }
  return true;
}

export interface ResolvedPolicy {
  principal: string;
  run: PolicyRunTarget;
  profile: ResolvedProfile;
  /** Index of the matched rule, or -1 when none matched (fail-closed locked). */
  ruleIndex: number;
}

/** Resolve the full policy outcome for a single context. */
export function resolvePolicy(cfg: AppConfig, ctx: PolicyContext): ResolvedPolicy {
  const policy = effectivePolicy(cfg);
  const principal = principalOf(policy, ctx.senderId);
  const run = runTargetForPrincipal(policy, principal);
  const rules = policy.rules ?? [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule && matchRule(rule, principal, ctx)) {
      return { principal, run, profile: resolveProfile(rule.profile, policy.profiles), ruleIndex: i };
    }
  }
  // No rule matched: fail closed rather than fall open to the full tool set.
  return { principal, run, profile: LOCKED_PROFILE, ruleIndex: -1 };
}

/**
 * Where a sender's runs execute (front/worker). Consulted by the relay router.
 * `scenario` (the chat type of the triggering event) gates per-principal
 * `relayScenarios`: a worker-bound principal only relays the scenarios it lists
 * (default: all). An unknown scenario (e.g. a doc comment) never satisfies an
 * explicit restriction, so it stays on the front.
 */
export function relayRunTarget(
  cfg: AppConfig,
  senderId: string | undefined,
  scenario?: PolicyScenario,
): PolicyRunTarget {
  const policy = effectivePolicy(cfg);
  const principal = principalOf(policy, senderId);
  if (runTargetForPrincipal(policy, principal) !== 'worker') return 'front';
  const { relayScenarios } = normalizePrincipal(policy.principals?.[principal]);
  if (relayScenarios && !scenarioMatches(relayScenarios, scenario)) return 'front';
  return 'worker';
}

function rank(p: ResolvedProfile): number {
  if (p.name === 'locked' || p.name.startsWith('locked(')) return 2;
  return p.restricted ? 1 : 0;
}

/**
 * Resolve the profile for a whole batch (a debounced run can carry messages
 * from several senders in a group). The MOST RESTRICTIVE sender wins —
 * locked > restricted > full — so one untrusted sender can never lift the
 * batch into a more permissive mode (mirrors the legacy "all must be trusted
 * for full" rule). If two senders resolve to DIFFERENT restricted profiles,
 * neither's tool set is safe for the other, so the batch fails closed to
 * `locked` rather than running one sender under the other's permissions.
 */
export function resolveBatchProfile(
  cfg: AppConfig,
  senderIds: (string | undefined)[],
  ctx: { chat?: PolicyScenario; chatId?: string },
): { profile: ResolvedProfile; principals: string[] } {
  const senders = senderIds.length > 0 ? senderIds : [undefined];
  const resolved = senders.map((senderId) =>
    resolvePolicy(cfg, { senderId, chat: ctx.chat, chatId: ctx.chatId }),
  );
  const principals = unique(resolved.map((r) => r.principal));
  const maxRank = Math.max(...resolved.map((r) => rank(r.profile)));
  // The most-restrictive tier decides. If every sender in that tier resolved to
  // the SAME profile, use it verbatim (honoring its overrides incl. custom
  // `extensions` limiters). A mixed tier — even mixed `full` profiles — fails
  // closed to `locked` rather than silently dropping one sender's limiter hooks
  // or running someone under another's permissions.
  const tier = resolved.filter((r) => rank(r.profile) === maxRank).map((r) => r.profile);
  const names = new Set(tier.map((p) => p.name));
  if (names.size === 1) return { profile: tier[0] ?? LOCKED_PROFILE, principals };
  log.warn('policy', 'mixed-profile-batch', { rank: maxRank, profiles: [...names] });
  return { profile: LOCKED_PROFILE, principals };
}

export type InjectionDecision = 'no-run' | 'inject' | 'defer';

/**
 * Decide what to do with a message that arrives while a run is ALREADY active
 * for its scope (the mid-run path that bypasses the debounce batch entirely).
 *
 * The active run was spawned with one profile's tools. Injecting a message
 * whose own sender resolves to a DIFFERENT profile would run that sender under
 * the active profile's permissions — the exact escalation `resolveBatchProfile`
 * guards against for batches (and even two different profiles in one batch fail
 * closed). So injection is allowed ONLY when the incoming sender resolves to the
 * SAME profile name as the active run. Otherwise the message is deferred: it
 * falls back to the pending queue and runs after the active run ends, under its
 * own (correctly resolved) profile.
 *
 * `activeProfileName` is the profile the active run was started with, or
 * undefined when no run is active for the scope.
 */
export function injectionDecision(
  cfg: AppConfig,
  senderId: string | undefined,
  ctx: { chat?: PolicyScenario; chatId?: string },
  activeProfileName: string | undefined,
): InjectionDecision {
  if (activeProfileName === undefined) return 'no-run';
  const { profile } = resolveBatchProfile(cfg, [senderId], ctx);
  return profile.name === activeProfileName ? 'inject' : 'defer';
}

/** Policy when none is configured: everyone runs `full`, nothing relays. */
const DEFAULT_OPEN_POLICY: PolicyConfig = {
  principals: {},
  profiles: {},
  rules: [{ profile: 'full' }],
};

/** The explicit policy when set, else the built-in open default. */
export function effectivePolicy(cfg: AppConfig): PolicyConfig {
  return cfg.policy ?? DEFAULT_OPEN_POLICY;
}
