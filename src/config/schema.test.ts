import { describe, expect, it } from 'vitest';
import {
  getGuestCommandTools,
  getGuestFeishuHostTools,
  getGuestPolicy,
  getGuestSystemPrompt,
  getGuestToolAllowlist,
  getOmpBinary,
  getOmpModel,
  getOmpSessionDir,
  getOmpThinking,
  getOmpTools,
  isUnrestrictedUser,
  type AppConfig,
} from './schema';

function cfg(preferences: AppConfig['preferences'] = {}): AppConfig {
  return {
    accounts: { app: { id: 'cli_x', secret: 'secret', tenant: 'feishu' } },
    preferences,
  };
}

describe('OMP preferences', () => {
  it('defaults OMP binary to omp', () => {
    expect(getOmpBinary(cfg())).toBe('omp');
  });

  it('trims configured OMP binary and model', () => {
    expect(getOmpBinary(cfg({ ompBinary: ' /opt/bin/omp ' }))).toBe('/opt/bin/omp');
    expect(getOmpModel(cfg({ ompModel: ' gpt-5.5 ' }))).toBe('gpt-5.5');
  });

  it('falls back to legacy Codex binary and model when OMP fields are absent', () => {
    expect(getOmpBinary(cfg({ codexBinary: ' /opt/bin/codex ' }))).toBe('/opt/bin/codex');
    expect(getOmpModel(cfg({ codexModel: ' gpt-5.1 ' }))).toBe('gpt-5.1');
  });

  it('omits empty optional OMP flags', () => {
    expect(getOmpModel(cfg({ ompModel: '   ' }))).toBeUndefined();
    expect(getOmpThinking(cfg({ ompThinking: '   ' }))).toBeUndefined();
    expect(getOmpTools(cfg({ ompTools: '   ' }))).toBeUndefined();
  });

  it('trims OMP thinking, tools, and session dir', () => {
    expect(getOmpThinking(cfg({ ompThinking: ' xhigh ' }))).toBe('xhigh');
    expect(getOmpTools(cfg({ ompTools: ' read,bash ' }))).toBe('read,bash');
    expect(getOmpSessionDir(cfg({ ompSessionDir: ' /tmp/sessions ' }))).toBe('/tmp/sessions');
  });
});

describe('guest tool policy', () => {
  it('treats everyone as unrestricted when no policy is set', () => {
    expect(getGuestPolicy(cfg())).toBeUndefined();
    expect(isUnrestrictedUser(cfg(), 'ou_anyone')).toBe(true);
    expect(getGuestToolAllowlist(cfg())).toEqual([]);
    expect(getGuestCommandTools(cfg())).toEqual([]);
  });

  it('exempts listed unrestricted users and sandboxes the rest', () => {
    const c = cfg({ guestPolicy: { unrestrictedUsers: ['ou_owner'] } });
    expect(isUnrestrictedUser(c, 'ou_owner')).toBe(true);
    expect(isUnrestrictedUser(c, 'ou_stranger')).toBe(false);
  });

  it('falls back to admins when unrestrictedUsers is unset', () => {
    const c = cfg({ guestPolicy: {}, access: { admins: ['ou_owner'] } });
    expect(isUnrestrictedUser(c, 'ou_owner')).toBe(true);
    expect(isUnrestrictedUser(c, 'ou_stranger')).toBe(false);
  });

  it('exempts nobody when a policy is present but no trusted list resolves', () => {
    const c = cfg({ guestPolicy: {} });
    expect(isUnrestrictedUser(c, 'ou_owner')).toBe(false);
  });

  it('validates command tools: drops bad names/commands, dedupes, fills defaults', () => {
    const c = cfg({
      guestPolicy: {
        commandTools: [
          { name: 'zendesk_kg', command: 'zendesk-kg', allowedSubcommands: ['search', 'stats'] },
          { name: 'bad name', command: 'x' }, // invalid name (space)
          { name: 'noCmd', command: '   ' }, // empty command
          { name: 'zendesk_kg', command: 'dupe' }, // duplicate name dropped
        ] as never,
      },
    });
    const tools = getGuestCommandTools(c);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('zendesk_kg');
    expect(tools[0]?.command).toBe('zendesk-kg');
    expect(tools[0]?.allowedSubcommands).toEqual(['search', 'stats']);
    expect(tools[0]?.timeoutMs).toBe(120_000);
    expect(tools[0]?.maxOutputBytes).toBe(30_000);
  });

  it('clamps timeout and output bounds', () => {
    const c = cfg({
      guestPolicy: {
        commandTools: [
          { name: 't', command: 'x', timeoutMs: 999_999_999, maxOutputBytes: 1 },
        ],
      },
    });
    const t = getGuestCommandTools(c)[0];
    expect(t?.timeoutMs).toBe(600_000);
    expect(t?.maxOutputBytes).toBe(1000);
  });

  it('builds the hook allowlist from command-tool names plus extras, deduped', () => {
    const c = cfg({
      guestPolicy: {
        commandTools: [{ name: 'zendesk_kg', command: 'zendesk-kg' }],
        extraToolAllowlist: ['read', 'zendesk_kg'],
      },
    });
    expect(getGuestToolAllowlist(c).sort()).toEqual(['read', 'zendesk_kg']);
  });

  it('defaults feishu host tools off for guests', () => {
    expect(getGuestFeishuHostTools(cfg({ guestPolicy: {} }))).toBe(false);
    expect(getGuestFeishuHostTools(cfg({ guestPolicy: { feishuHostTools: true } }))).toBe(true);
  });

  it('resolves the guest system prompt, treating blank as unset', () => {
    expect(getGuestSystemPrompt(cfg({ guestPolicy: {} }))).toBeUndefined();
    expect(getGuestSystemPrompt(cfg({ guestPolicy: { systemPrompt: '   ' } }))).toBeUndefined();
    expect(getGuestSystemPrompt(cfg({ guestPolicy: { systemPrompt: '你可以用 zendesk-kg' } }))).toBe('你可以用 zendesk-kg');
  });
});
