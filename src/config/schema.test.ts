import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import {
  getOmpBinary,
  getDefaultCwd,
  getOmpModel,
  getOmpSessionDir,
  getOmpThinking,
  getOmpTools,
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

describe('getDefaultCwd', () => {
  it('defaults to the home directory when unset or blank', () => {
    expect(getDefaultCwd(cfg())).toBe(homedir());
    expect(getDefaultCwd(cfg({ defaultCwd: '   ' }))).toBe(homedir());
  });

  it('returns a trimmed absolute path as-is', () => {
    expect(getDefaultCwd(cfg({ defaultCwd: ' /repos/tmp ' }))).toBe('/repos/tmp');
  });

  it('expands a leading ~ to the home directory', () => {
    expect(getDefaultCwd(cfg({ defaultCwd: '~' }))).toBe(homedir());
    expect(getDefaultCwd(cfg({ defaultCwd: '~/repos/tmp' }))).toBe(`${homedir()}/repos/tmp`);
  });
});
