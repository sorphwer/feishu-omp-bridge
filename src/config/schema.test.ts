import { describe, expect, it } from 'vitest';
import {
  assertNoLegacyPolicyFields,
  getMessageReplyMode,
  getOmpBinary,
  getOmpModel,
  getOmpSessionDir,
  getOmpThinking,
  getOmpTools,
  normalizeCommandTools,
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

describe('getMessageReplyMode', () => {
  it('coerces removed text mode to markdown', () => {
    const cfg = { preferences: { messageReply: 'text' } } as never;
    expect(getMessageReplyMode(cfg)).toBe('markdown');
  });

  it('defaults to markdown', () => {
    expect(getMessageReplyMode({} as never)).toBe('markdown');
  });
});

describe('normalizeCommandTools', () => {
  it('validates command tools: drops bad names/commands, dedupes, fills defaults', () => {
    const tools = normalizeCommandTools([
      { name: 'zendesk_kg', command: 'zendesk-kg', allowedSubcommands: ['search', 'stats'] },
      { name: 'bad name', command: 'x' }, // invalid name (space)
      { name: 'noCmd', command: '   ' }, // empty command
      { name: 'zendesk_kg', command: 'dupe' }, // duplicate name dropped
    ] as never);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('zendesk_kg');
    expect(tools[0]?.command).toBe('zendesk-kg');
    expect(tools[0]?.allowedSubcommands).toEqual(['search', 'stats']);
    expect(tools[0]?.timeoutMs).toBe(120_000);
    expect(tools[0]?.maxOutputBytes).toBe(30_000);
  });

  it('clamps timeout and output bounds', () => {
    const tools = normalizeCommandTools([
      { name: 't', command: 'x', timeoutMs: 999_999_999, maxOutputBytes: 1 },
    ]);
    expect(tools[0]?.timeoutMs).toBe(600_000);
    expect(tools[0]?.maxOutputBytes).toBe(1000);
  });
});

describe('assertNoLegacyPolicyFields', () => {
  it('rejects preferences.guestPolicy', () => {
    expect(() =>
      assertNoLegacyPolicyFields({ preferences: { guestPolicy: {} } } as never),
    ).toThrow(/guestPolicy/);
  });
  it('rejects relay.route', () => {
    expect(() =>
      assertNoLegacyPolicyFields({ relay: { role: 'front', route: { users: [] } } } as never),
    ).toThrow(/relay\.route/);
  });
  it('passes a clean config', () => {
    expect(() => assertNoLegacyPolicyFields({})).not.toThrow();
  });
});
