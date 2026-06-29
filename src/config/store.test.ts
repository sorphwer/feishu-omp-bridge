import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from './schema';
import { loadConfig, saveConfig } from './store';

describe('config store — YAML support', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('reads a hand-written YAML config', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fob-cfg-'));
    const p = join(dir, 'config.yaml');
    await writeFile(
      p,
      [
        'accounts:',
        '  app:',
        '    id: cli_y',
        '    secret: s',
        '    tenant: feishu',
        'policy:',
        '  profiles:',
        '    kb:',
        '      tools: [read, search]',
        '',
      ].join('\n'),
      'utf8',
    );
    const cfg = await loadConfig(p);
    expect(cfg.accounts?.app?.id).toBe('cli_y');
    expect(cfg.policy?.profiles?.kb?.tools).toEqual(['read', 'search']);
  });

  it('round-trips a config through YAML for a .yaml path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fob-cfg-'));
    const p = join(dir, 'config.yaml');
    const cfg: AppConfig = {
      accounts: { app: { id: 'cli_z', secret: { source: 'env', id: 'X' }, tenant: 'lark' } },
      policy: { principals: { owner: { users: ['ou_o'], run: 'worker' } } },
    };
    await saveConfig(cfg, p);
    const text = await readFile(p, 'utf8');
    // Block-style YAML, not JSON.
    expect(text).not.toContain('"accounts"');
    expect(await loadConfig(p)).toEqual(cfg);
  });

  it('writes JSON for a .json path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'fob-cfg-'));
    const p = join(dir, 'config.json');
    const cfg: AppConfig = {
      accounts: { app: { id: 'cli_j', secret: 's', tenant: 'feishu' } },
    };
    await saveConfig(cfg, p);
    const text = await readFile(p, 'utf8');
    expect(text.trimStart().startsWith('{')).toBe(true);
    expect(await loadConfig(p)).toEqual(cfg);
  });
});
