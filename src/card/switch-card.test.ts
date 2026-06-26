import { describe, expect, it } from 'vitest';
import type { OmpModelInfo } from '../agent';
import { OMP_DEFAULT_MODEL_VALUE, switchModelFormCard } from './switch-card';

interface Option {
  text: { content: string };
  value: string;
}

function form(card: object): {
  intro: string;
  modelOptions: Option[];
  modelInitial: string;
  hasCustomInput: boolean;
} {
  const c = card as {
    body: {
      elements: Array<{
        tag: string;
        content?: string;
        elements?: Array<{ tag: string; name?: string; initial_option?: string; options?: Option[] }>;
      }>;
    };
  };
  const intro = c.body.elements[0]!.content ?? '';
  const els = c.body.elements[2]!.elements ?? [];
  const sel = els.find((e) => e.tag === 'select_static' && e.name === 'model')!;
  const input = els.find((e) => e.tag === 'input' && e.name === 'custom');
  return {
    intro,
    modelOptions: sel.options ?? [],
    modelInitial: sel.initial_option ?? '',
    hasCustomInput: Boolean(input),
  };
}

function m(provider: string, id: string, name?: string): OmpModelInfo {
  return { provider, id, selector: `${provider}/${id}`, name: name ?? id };
}

const ROLES = [
  m('anthropic', 'claude-opus-4-8', 'Claude Opus 4.8'),
  m('openai-codex', 'gpt-5.5', 'GPT-5.5'),
];

describe('switchModelFormCard', () => {
  it('lists only role models plus the default sentinel', () => {
    const f = form(switchModelFormCard({ roleModels: ROLES, authenticated: ['anthropic'] }));
    expect(f.modelOptions.map((o) => o.value)).toEqual([
      'anthropic/claude-opus-4-8',
      'openai-codex/gpt-5.5',
      OMP_DEFAULT_MODEL_VALUE,
    ]);
    expect(f.hasCustomInput).toBe(false);
  });

  it('shows the effective current/default model in the intro', () => {
    const withDefault = form(
      switchModelFormCard({ defaultModel: 'anthropic/claude-opus-4-8', roleModels: ROLES, authenticated: [] }),
    );
    expect(withDefault.intro).toContain('anthropic/claude-opus-4-8');

    const withCurrent = form(
      switchModelFormCard({ current: 'openai-codex/gpt-5.5', roleModels: ROLES, authenticated: [] }),
    );
    expect(withCurrent.intro).toContain('openai-codex/gpt-5.5');
  });

  it('marks ✅ on authenticated providers and · 默认 on the default model', () => {
    const f = form(
      switchModelFormCard({
        defaultModel: 'anthropic/claude-opus-4-8',
        roleModels: ROLES,
        authenticated: ['anthropic'],
      }),
    );
    const opus = f.modelOptions.find((o) => o.value === 'anthropic/claude-opus-4-8')!;
    const gpt = f.modelOptions.find((o) => o.value === 'openai-codex/gpt-5.5')!;
    expect(opus.text.content.startsWith('✅')).toBe(true);
    expect(opus.text.content).toContain('· 默认');
    expect(gpt.text.content.startsWith('✅')).toBe(false);
  });

  it('marks and selects the current model when it is a role model', () => {
    const f = form(
      switchModelFormCard({ current: 'openai-codex/gpt-5.5', roleModels: ROLES, authenticated: [] }),
    );
    expect(f.modelInitial).toBe('openai-codex/gpt-5.5');
    expect(f.modelOptions.find((o) => o.value === 'openai-codex/gpt-5.5')!.text.content).toContain('← 当前');
  });

  it('preserves a current model absent from the role list', () => {
    const f = form(
      switchModelFormCard({ current: 'xiaomi/mimo-1', roleModels: ROLES, authenticated: [] }),
    );
    expect(f.modelOptions[0]!.value).toBe('xiaomi/mimo-1');
    expect(f.modelInitial).toBe('xiaomi/mimo-1');
  });

  it('defaults to the sentinel when no current/override', () => {
    const f = form(switchModelFormCard({ roleModels: ROLES, authenticated: [] }));
    expect(f.modelInitial).toBe(OMP_DEFAULT_MODEL_VALUE);
  });
});
