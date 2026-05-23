import { describe, expect, it } from 'vitest';
import { getCodexBinary, getCodexModel, type AppConfig } from './schema';

function cfg(preferences: AppConfig['preferences'] = {}): AppConfig {
  return {
    accounts: { app: { id: 'cli_x', secret: 'secret', tenant: 'feishu' } },
    preferences,
  };
}

describe('Codex preferences', () => {
  it('defaults Codex binary to codex', () => {
    expect(getCodexBinary(cfg())).toBe('codex');
  });

  it('trims configured Codex binary and model', () => {
    expect(getCodexBinary(cfg({ codexBinary: ' /opt/bin/codex ' }))).toBe('/opt/bin/codex');
    expect(getCodexModel(cfg({ codexModel: ' gpt-5.1 ' }))).toBe('gpt-5.1');
  });

  it('omits an empty Codex model so Codex config can decide', () => {
    expect(getCodexModel(cfg({ codexModel: '   ' }))).toBeUndefined();
  });
});
