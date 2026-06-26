import { afterEach, describe, expect, it } from 'vitest';
import {
  isProviderAuthenticated,
  roleModels,
  setAuthenticatedProviders,
  setModelCatalog,
  setModelRoles,
  type OmpModelInfo,
} from './model-catalog';

function m(provider: string, id: string): OmpModelInfo {
  return { provider, id, selector: `${provider}/${id}`, name: id };
}

const CATALOG = [
  m('anthropic', 'claude-opus-4-8'),
  m('anthropic', 'claude-sonnet-4-6'),
  m('openai-codex', 'gpt-5.5'),
  m('xiaomi', 'mimo-v2.5-pro'),
];

afterEach(() => {
  setModelCatalog([]);
  setAuthenticatedProviders([]);
  setModelRoles({ roles: [] });
});

describe('roleModels', () => {
  it('returns role-bound selectors in role order, resolved to catalog entries', () => {
    setModelCatalog(CATALOG);
    setModelRoles({
      default: 'openai-codex/gpt-5.5',
      roles: ['openai-codex/gpt-5.5', 'anthropic/claude-opus-4-8'],
    });
    expect(roleModels().map((x) => x.selector)).toEqual([
      'openai-codex/gpt-5.5',
      'anthropic/claude-opus-4-8',
    ]);
  });

  it('synthesizes an entry for a role selector absent from the catalog', () => {
    setModelCatalog(CATALOG);
    setModelRoles({ roles: ['xiaomi/mimo-v9-custom'] });
    const out = roleModels();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ provider: 'xiaomi', id: 'mimo-v9-custom', selector: 'xiaomi/mimo-v9-custom' });
  });

  it('is empty when no roles are set', () => {
    setModelCatalog(CATALOG);
    expect(roleModels()).toEqual([]);
  });
});

describe('isProviderAuthenticated', () => {
  it('is true for listed providers and true-for-all when unknown', () => {
    setAuthenticatedProviders(['anthropic']);
    expect(isProviderAuthenticated('anthropic')).toBe(true);
    expect(isProviderAuthenticated('xiaomi')).toBe(false);

    setAuthenticatedProviders([]);
    expect(isProviderAuthenticated('xiaomi')).toBe(true);
  });
});
