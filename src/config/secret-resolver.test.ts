import { describe, expect, it } from 'vitest';
import type { AppConfig } from './schema';
import { resolveRelaySecret } from './secret-resolver';

const base: AppConfig = {
  accounts: { app: { id: 'cli_x', secret: 's', tenant: 'feishu' } },
};

describe('resolveRelaySecret', () => {
  it('falls back to the app secret when relay.secret is unset', async () => {
    expect(await resolveRelaySecret(base, 'APPSEC')).toBe('APPSEC');
    const noOverride: AppConfig = { ...base, relay: { role: 'worker', endpoint: 'https://x' } };
    expect(await resolveRelaySecret(noOverride, 'APPSEC')).toBe('APPSEC');
  });

  it('uses relay.secret (plain string) when set, independent of the app secret', async () => {
    const cfg: AppConfig = { ...base, relay: { role: 'front', secret: 'RELAYSEC' } };
    expect(await resolveRelaySecret(cfg, 'APPSEC')).toBe('RELAYSEC');
  });
});
