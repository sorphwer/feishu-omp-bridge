import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paths } from './paths';
import {
  effectivePolicy,
  hasWorkerPrincipal,
  injectionDecision,
  principalOf,
  relayRunTarget,
  resolveBatchProfile,
  resolvePolicy,
  resolveProfile,
} from './policy';
import type { AppConfig, PolicyConfig } from './schema';

function cfg(partial: Partial<AppConfig>): AppConfig {
  return {
    accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
    ...partial,
  };
}

describe('effectivePolicy without explicit policy', () => {
  it('falls back to everyone-full, nobody-relayed', () => {
    const c = {} as AppConfig;
    const p = effectivePolicy(c);
    expect(p.rules).toEqual([{ profile: 'full' }]);
    expect(Object.keys(p.principals ?? {})).toHaveLength(0);
    const { profile } = resolveBatchProfile(c, ['ou_anyone'], { chat: 'group' });
    expect(profile.name).toBe('full');
    expect(relayRunTarget(c, 'ou_anyone', 'p2p')).toBe('front');
  });
});

describe('hasWorkerPrincipal', () => {
  it('is false for the built-in open default (wizard + hand-added relay, no policy)', () => {
    // Repro of the "wizard-generated + hand-added relay" config shape: a
    // `relay: {role:'front'}` plus non-empty `access.admins` but NO explicit
    // `policy` — the removed guestPolicy/access.admins auto-relay fallback
    // used to route these admins to a worker; now there is no such fallback,
    // so a front started with only this shape relays nobody.
    const c = cfg({
      relay: { role: 'front' },
      preferences: { access: { admins: ['ou_admin'] } },
    });
    expect(hasWorkerPrincipal(effectivePolicy(c))).toBe(false);
  });

  it('is false when every principal is shorthand (string[] = run: front)', () => {
    const policy: PolicyConfig = { principals: { team: ['ou_a', 'ou_b'] } };
    expect(hasWorkerPrincipal(policy)).toBe(false);
  });

  it('is false when a principal explicitly sets run: front', () => {
    const policy: PolicyConfig = { principals: { owner: { users: ['ou_a'], run: 'front' } } };
    expect(hasWorkerPrincipal(policy)).toBe(false);
  });

  it('is true when at least one principal sets run: worker', () => {
    const policy: PolicyConfig = {
      principals: { team: ['ou_a'], owner: { users: ['ou_b'], run: 'worker' } },
    };
    expect(hasWorkerPrincipal(policy)).toBe(true);
  });
});

describe('explicit policy', () => {
  const policy: PolicyConfig = {
    principals: {
      owner: { users: ['ou_owner'], run: 'worker' },
      team: ['ou_a', 'ou_b'],
    },
    profiles: {
      readonly: { tools: ['read', 'search'] },
      kb: { tools: [], commandTools: [{ name: 'zendesk_kg', command: 'zendesk-kg' }] },
    },
    rules: [
      { when: { chat: 'p2p', principal: 'owner' }, profile: 'full' },
      { when: { chat: 'p2p', principal: 'team' }, profile: 'readonly' },
      { when: { chat: 'group' }, profile: 'kb' },
    ],
  };
  const c = cfg({ policy });

  it('resolves owner DM to full @worker', () => {
    const r = resolvePolicy(c, { senderId: 'ou_owner', chat: 'p2p' });
    expect(r.profile.name).toBe('full');
    expect(r.run).toBe('worker');
  });

  it('resolves team DM to the readonly profile @front', () => {
    const r = resolvePolicy(c, { senderId: 'ou_a', chat: 'p2p' });
    expect(r.profile.name).toBe('readonly');
    expect(r.profile.builtinTools).toEqual(['read', 'search']);
    expect(r.run).toBe('front');
  });

  it('group rule (chat: group) also matches a topic group', () => {
    const r = resolvePolicy(c, { senderId: 'ou_owner', chat: 'topic' });
    expect(r.profile.name).toBe('kb');
  });

  it('fails closed to locked when no rule matches', () => {
    const r = resolvePolicy(c, { senderId: 'ou_stranger', chat: 'p2p' });
    expect(r.profile.name).toBe('locked');
    expect(r.ruleIndex).toBe(-1);
    expect(r.profile.restricted).toBe(true);
    expect(r.profile.builtinTools).toEqual([]);
  });

  it('classifies principals correctly', () => {
    const p = effectivePolicy(c);
    expect(principalOf(p, 'ou_owner')).toBe('owner');
    expect(principalOf(p, 'ou_b')).toBe('team');
    expect(principalOf(p, 'ou_stranger')).toBe('guest');
    expect(principalOf(p, undefined)).toBe('guest');
  });
});

describe('resolveProfile', () => {
  it('returns the full set with no sandbox for full', () => {
    const p = resolveProfile('full', undefined);
    expect(p.restricted).toBe(false);
    expect(p.feishuHostTools).toBe(true);
  });

  it('fails closed to locked for an unknown profile name', () => {
    const p = resolveProfile('typo', { real: { tools: ['read'] } });
    expect(p.restricted).toBe(true);
    expect(p.name).toBe('locked(typo)');
    expect(p.builtinTools).toEqual([]);
    expect(p.feishuHostTools).toBe(false);
  });

  it('honors discovery/memory/feishu overrides on a full profile', () => {
    const p = resolveProfile('fullish', {
      fullish: { tools: 'all', discovery: 'off', memory: 'off', feishuHostTools: false },
    });
    expect(p.restricted).toBe(false);
    expect(p.discovery).toBe(false);
    expect(p.memory).toBe(false);
    expect(p.feishuHostTools).toBe(false);
  });

  it('resolves extension hook paths (absolute / ~ / relative-to-appDir)', () => {
    const p = resolveProfile('x', {
      x: { tools: ['read'], extensions: ['/abs/hook.mjs', '~/h.mjs', 'rel/h.mjs'] },
    });
    expect(p.extensions[0]).toBe('/abs/hook.mjs');
    expect(p.extensions[1]).toBe(join(homedir(), 'h.mjs'));
    expect(p.extensions[2]).toBe(join(paths.appDir, 'rel/h.mjs'));
  });

  it('defaults extensions to an empty array', () => {
    expect(resolveProfile('full', undefined).extensions).toEqual([]);
    expect(resolveProfile('y', { y: { tools: ['read'] } }).extensions).toEqual([]);
  });
});

describe('resolveBatchProfile', () => {
  const c = cfg({
    policy: {
      principals: { owner: ['ou_owner'] },
      profiles: { kb: { tools: ['read'] }, ops: { tools: ['bash'] } },
      rules: [
        { when: { principal: 'owner' }, profile: 'full' },
        { when: { principal: 'guest' }, profile: 'kb' },
      ],
    },
  });

  it('lets the most restrictive sender win', () => {
    const r = resolveBatchProfile(c, ['ou_owner', 'ou_stranger'], { chat: 'group' });
    expect(r.profile.name).toBe('kb');
  });

  it('keeps full only when every sender is full', () => {
    const r = resolveBatchProfile(c, ['ou_owner'], { chat: 'p2p' });
    expect(r.profile.name).toBe('full');
  });

  it('fails closed when senders resolve to different restricted profiles', () => {
    const c2 = cfg({
      policy: {
        principals: { a: ['ou_a'], b: ['ou_b'] },
        profiles: { kb: { tools: ['read'] }, ops: { tools: ['bash'] } },
        rules: [
          { when: { principal: 'a' }, profile: 'kb' },
          { when: { principal: 'b' }, profile: 'ops' },
        ],
      },
    });
    const r = resolveBatchProfile(c2, ['ou_a', 'ou_b'], { chat: 'group' });
    expect(r.profile.name).toBe('locked');
  });

  it('treats a missing senderId as guest (fail-closed)', () => {
    const r = resolveBatchProfile(c, [undefined], { chat: 'p2p' });
    expect(r.profile.name).toBe('kb');
  });
});

describe('injectionDecision (mid-run join gate)', () => {
  const c = cfg({
    policy: {
      principals: { owner: ['ou_owner'] },
      profiles: { kb: { tools: ['read'] } },
      rules: [
        { when: { principal: 'owner' }, profile: 'full' },
        { when: { principal: 'guest' }, profile: 'kb' },
      ],
    },
  });

  it('returns no-run when nothing is active for the scope', () => {
    expect(injectionDecision(c, 'ou_owner', { chat: 'group' }, undefined)).toBe('no-run');
  });

  it('injects when the sender resolves to the same profile as the active run', () => {
    expect(injectionDecision(c, 'ou_owner', { chat: 'group' }, 'full')).toBe('inject');
  });

  it('defers a lower-privilege sender trying to join a full run (no escalation)', () => {
    // The exact scenario: a guest interjects while the owner's `full` run streams.
    expect(injectionDecision(c, 'ou_stranger', { chat: 'group' }, 'full')).toBe('defer');
  });

  it('defers a full sender from joining a restricted run (no identity mixing)', () => {
    expect(injectionDecision(c, 'ou_owner', { chat: 'group' }, 'kb')).toBe('defer');
  });

  it('lets a same-tier guest join another guest run', () => {
    expect(injectionDecision(c, 'ou_stranger', { chat: 'group' }, 'kb')).toBe('inject');
  });
});
