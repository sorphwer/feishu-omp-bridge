import { describe, expect, it } from 'vitest';
import { guestHookSource, guestOverlayYaml } from './guest-lockdown';

describe('guestOverlayYaml', () => {
  it('disables discovery sources so config-sourced MCP never loads', () => {
    const yaml = guestOverlayYaml();
    expect(yaml).toContain('disabledProviders:');
    for (const src of ['native', 'claude', 'codex', 'gemini', 'github', 'opencode', 'cursor', 'agents-md']) {
      expect(yaml).toContain(`- ${src}`);
    }
    expect(yaml).toContain('discoveryMode: off');
  });

  it('disables the shared memory backend for guests', () => {
    const yaml = guestOverlayYaml();
    expect(yaml).toContain('memory:');
    expect(yaml).toContain('backend: "off"');
  });
});

describe('guestHookSource', () => {
  const noLimits = { maxTotal: 0, perTool: {} };

  it('emits a fail-closed allowlist hook embedding the allowed tool names', () => {
    const src = guestHookSource(['zendesk_kg', 'read'], noLimits);
    expect(src).toContain('const ALLOWED = new Set(["zendesk_kg","read"])');
    expect(src).toContain('pi.on("tool_call"');
    expect(src).toContain('block: true');
    expect(src).toContain('export default function hook');
  });

  it('blocks everything when the allowlist is empty', () => {
    const src = guestHookSource([], noLimits);
    expect(src).toContain('const ALLOWED = new Set([])');
    expect(src).toContain('block: true');
  });

  it('bakes per-run total and per-tool call caps', () => {
    const src = guestHookSource(['zendesk_kg'], { maxTotal: 12, perTool: { zendesk_kg: 8 } });
    expect(src).toContain('const MAX_TOTAL = 12');
    expect(src).toContain('const PER_TOOL = {"zendesk_kg":8}');
    expect(src).toContain('total > MAX_TOTAL');
    expect(src).toContain('counts[name] > cap');
  });
});
