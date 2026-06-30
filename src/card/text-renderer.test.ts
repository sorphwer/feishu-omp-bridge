import { describe, expect, it } from 'vitest';
import { renderText } from './text-renderer';
import { initialState, type RunBadge, type RunState } from './run-state';

function withBadge(badge: RunBadge | undefined): RunState {
  const blocks: RunState['blocks'] = [{ kind: 'text', content: 'hello', streaming: false }];
  return badge ? { ...initialState, badge, blocks } : { ...initialState, blocks };
}

describe('renderText profile badge line', () => {
  it('prepends a restricted badge with the owner', () => {
    const out = renderText(withBadge({ profileName: 'guest', restricted: true, owner: '张三' }));
    expect(out.startsWith('🔒 **guest（受限）** · @张三')).toBe(true);
  });

  it('uses 🔓 and no 受限 suffix for an unrestricted profile', () => {
    const out = renderText(withBadge({ profileName: 'full', restricted: false }));
    expect(out.startsWith('🔓 **full**')).toBe(true);
    expect(out).not.toContain('受限');
  });

  it('uses ⛔ for a locked profile', () => {
    const out = renderText(withBadge({ profileName: 'locked', restricted: true }));
    expect(out.startsWith('⛔ **locked**')).toBe(true);
  });

  it('emits no badge line for a badge-less (p2p) run', () => {
    const out = renderText(withBadge(undefined));
    expect(out.startsWith('hello')).toBe(true);
  });
});
