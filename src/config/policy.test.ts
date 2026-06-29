import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paths } from './paths';
import {
  effectivePolicy,
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

describe('legacy synthesis — no guestPolicy', () => {
  it('runs everyone full and relays the route.users set to a worker', () => {
    const c = cfg({ relay: { role: 'front', route: { users: ['ou_me'] } } });
    expect(resolvePolicy(c, { senderId: 'ou_me', chat: 'p2p' }).profile.name).toBe('full');
    expect(resolvePolicy(c, { senderId: 'ou_anyone', chat: 'group' }).profile.name).toBe('full');
    expect(relayRunTarget(c, 'ou_me')).toBe('worker');
    expect(relayRunTarget(c, 'ou_anyone')).toBe('front');
  });

  it('relays nobody when there is no relay config', () => {
    const c = cfg({});
    expect(relayRunTarget(c, 'ou_me')).toBe('front');
    expect(resolvePolicy(c, { senderId: 'ou_me', chat: 'p2p' }).profile.name).toBe('full');
  });
});

describe('legacy synthesis — with guestPolicy', () => {
  const c = cfg({
    preferences: {
      access: { admins: ['ou_owner'] },
      guestPolicy: {
        unrestrictedUsers: ['ou_owner'],
        commandTools: [{ name: 'zendesk_kg', command: 'zendesk-kg' }],
        extraToolAllowlist: ['read'],
      },
    },
    relay: { role: 'front' },
  });

  it('gives the owner full tools in a DM', () => {
    const r = resolvePolicy(c, { senderId: 'ou_owner', chat: 'p2p' });
    expect(r.profile.name).toBe('full');
    expect(r.profile.restricted).toBe(false);
  });

  it('sandboxes the owner in a group (shared space)', () => {
    const r = resolvePolicy(c, { senderId: 'ou_owner', chat: 'group' });
    expect(r.profile.name).toBe('guest');
    expect(r.profile.restricted).toBe(true);
    expect(r.profile.builtinTools).toEqual(['read']);
    expect(r.profile.commandTools.map((t) => t.name)).toEqual(['zendesk_kg']);
    expect(r.profile.discovery).toBe(false);
    expect(r.profile.memory).toBe(false);
  });

  it('sandboxes a stranger even in a DM', () => {
    const r = resolvePolicy(c, { senderId: 'ou_stranger', chat: 'p2p' });
    expect(r.profile.name).toBe('guest');
    expect(r.profile.restricted).toBe(true);
  });

  it('routes the owner to a worker and strangers to the front', () => {
    expect(relayRunTarget(c, 'ou_owner')).toBe('worker');
    expect(relayRunTarget(c, 'ou_stranger')).toBe('front');
  });

  it('falls back to admins for the unrestricted set', () => {
    const c2 = cfg({
      preferences: { access: { admins: ['ou_admin'] }, guestPolicy: { commandTools: [] } },
    });
    expect(resolvePolicy(c2, { senderId: 'ou_admin', chat: 'p2p' }).profile.name).toBe('full');
    expect(resolvePolicy(c2, { senderId: 'ou_other', chat: 'p2p' }).profile.name).toBe('guest');
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
