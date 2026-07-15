/**
 * Live OMP model catalog, populated at startup from `omp models --json` and
 * re-probed each time `/switch` opens (see {@link OmpAdapter.refreshModels}).
 * The `/switch` picker reads this to
 * present a two-level provider→model choice over the actually-available
 * catalog rather than a hardcoded subset.
 *
 * If the probe fails (binary missing / non-zero exit / unparseable), the
 * built-in fallback below keeps `/switch` working with a sensible default.
 */

export interface OmpModelInfo {
  provider: string;
  id: string;
  /** Full `--model` selector, i.e. `${provider}/${id}`. */
  selector: string;
  /** Human-friendly display name; falls back to `id`. */
  name: string;
}

export interface OmpModelRoles {
  /** The `default` role selector (provider/id, thinking suffix stripped) —
   * the model OMP uses when no `--model` is passed. Undefined when unknown. */
  default?: string;
  /** All distinct role-bound selectors (provider/id, thinking suffix
   * stripped), in role declaration order. */
  roles: string[];
}

/** Minimal fallback used when `omp models --json` is unavailable. */
const FALLBACK_CATALOG: OmpModelInfo[] = [
  { provider: 'anthropic', id: 'claude-opus-4-8', selector: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8' },
  { provider: 'anthropic', id: 'claude-sonnet-4-6', selector: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { provider: 'openai-codex', id: 'gpt-5.5', selector: 'openai-codex/gpt-5.5', name: 'GPT-5.5' },
  { provider: 'openai-codex', id: 'gpt-5.2-codex', selector: 'openai-codex/gpt-5.2-codex', name: 'GPT-5.2 Codex' },
];

let catalog: OmpModelInfo[] = [];
let authenticatedProviders: string[] = [];
let modelRoles: OmpModelRoles = { roles: [] };

/** Set the role→model bindings (from `omp config get modelRoles --json`). */
export function setModelRoles(roles: OmpModelRoles): void {
  modelRoles = roles && Array.isArray(roles.roles) ? roles : { roles: [] };
}

/** The `default` role selector — the model OMP runs without `--model`. */
export function getDefaultRoleModel(): string | undefined {
  return modelRoles.default;
}

/** Replace the in-memory catalog (at startup and on `/switch` re-probe);
 * an empty list is ignored so the fallback stays in effect. */
export function setModelCatalog(models: OmpModelInfo[]): void {
  catalog = Array.isArray(models) ? models.filter((m) => m && m.provider && m.id && m.selector) : [];
}

/** Effective catalog: the probed list, or the built-in fallback when empty. */
function getModelCatalog(): OmpModelInfo[] {
  return catalog.length > 0 ? catalog : FALLBACK_CATALOG;
}

/**
 * Set the authenticated provider list (from `omp usage --json`). Empty means
 * "unknown" — the picker then offers every provider rather than filtering to
 * nothing.
 */
export function setAuthenticatedProviders(providers: string[]): void {
  authenticatedProviders = Array.isArray(providers) ? providers.filter(Boolean) : [];
}

/** Authenticated providers, or empty when unknown. */
export function getAuthenticatedProviders(): string[] {
  return authenticatedProviders;
}

/** True when a provider is authenticated, or when auth state is unknown. */
export function isProviderAuthenticated(provider: string): boolean {
  return authenticatedProviders.length === 0 || authenticatedProviders.includes(provider);
}

/**
 * Role-bound models offered in the `/switch` dropdown: each distinct
 * `modelRoles` selector resolved to its catalog entry, in role declaration
 * order. Selectors absent from the catalog are synthesized from `provider/id`
 * so they still appear.
 */
export function roleModels(): OmpModelInfo[] {
  const bySelector = new Map(getModelCatalog().map((m) => [m.selector, m]));
  const out: OmpModelInfo[] = [];
  for (const sel of modelRoles.roles) {
    const hit = bySelector.get(sel);
    if (hit) {
      out.push(hit);
      continue;
    }
    const slash = sel.indexOf('/');
    if (slash > 0) out.push({ provider: sel.slice(0, slash), id: sel.slice(slash + 1), selector: sel, name: sel.slice(slash + 1) });
  }
  return out;
}
