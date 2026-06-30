import { describe, expect, it } from 'vitest';
import { renderCard } from './run-renderer';
import { initialState, type RunBadge, type RunState } from './run-state';

function withBadge(badge: RunBadge | undefined): RunState {
  return badge ? { ...initialState, badge } : initialState;
}

describe('renderCard badge header', () => {
  it('renders a green unrestricted header with the owner subtitle', () => {
    const card = renderCard(withBadge({ profileName: 'full', restricted: false, owner: '张三' }));
    expect(card).toMatchObject({
      header: {
        template: 'green',
        title: { tag: 'plain_text', content: '🔓 full' },
        subtitle: { tag: 'plain_text', content: '@张三' },
      },
    });
  });

  it('renders a grey restricted header labelled 受限', () => {
    const card = renderCard(withBadge({ profileName: 'kb', restricted: true }));
    expect(card).toMatchObject({
      header: { template: 'grey', title: { tag: 'plain_text', content: '🔒 kb（受限）' } },
    });
  });

  it('renders a red locked header (no 受限 suffix)', () => {
    const card = renderCard(withBadge({ profileName: 'locked', restricted: true }));
    expect(card).toMatchObject({
      header: { template: 'red', title: { tag: 'plain_text', content: '⛔ locked' } },
    });
  });

  it('treats a locked(<name>) fail-closed profile as locked', () => {
    const card = renderCard(withBadge({ profileName: 'locked(typo)', restricted: true }));
    expect(card).toMatchObject({ header: { template: 'red', title: { content: '⛔ locked(typo)' } } });
  });

  it('omits the subtitle when the owner is unknown', () => {
    const card = renderCard(withBadge({ profileName: 'full', restricted: false }));
    expect(card).toHaveProperty('header');
    expect(card).not.toHaveProperty('header.subtitle');
  });

  it('emits no header for a badge-less (p2p) run', () => {
    const card = renderCard(initialState);
    expect(card).not.toHaveProperty('header');
  });
});
