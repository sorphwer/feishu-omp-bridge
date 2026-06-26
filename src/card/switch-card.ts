import type { OmpModelInfo } from '../agent';

/** Non-empty sentinel for "use OMP default / unset" (empty option values are
 * dropped by form parsing, so we need a real value to detect this choice). */
export const OMP_DEFAULT_MODEL_VALUE = '__omp_default__';

export interface SwitchModelFormOpts {
  /** The currently-applied `--model` selector (bridge override), if any. */
  current?: string;
  /** OMP's `modelRoles.default` — the model used when no override is set. */
  defaultModel?: string;
  /** Role-bound models (from OMP's `modelRoles`) to list in the dropdown. */
  roleModels: OmpModelInfo[];
  /** Providers known to be authenticated; empty = unknown (no ✅ marks). */
  authenticated: string[];
}

interface PlainOption {
  text: { tag: 'plain_text'; content: string };
  value: string;
}

function plainOption(content: string, value: string): PlainOption {
  return { text: { tag: 'plain_text', content }, value };
}

/**
 * Model picker: a dropdown of OMP's role-bound models (the `default` role is
 * tagged · 默认; authenticated providers get ✅). The active model is always
 * selectable, even when it isn't a role model.
 */
export function switchModelFormCard(opts: SwitchModelFormOpts): object {
  const authed = new Set(opts.authenticated);
  const mark = (provider: string): string =>
    authed.size > 0 && authed.has(provider) ? '✅ ' : '';

  const options: PlainOption[] = [];
  // Keep the current model selectable when it isn't a role model.
  if (opts.current && !opts.roleModels.some((m) => m.selector === opts.current)) {
    options.push(plainOption(`${opts.current}  ← 当前`, opts.current));
  }
  for (const m of opts.roleModels) {
    const base = m.name && m.name !== m.id ? `${m.name} · ${m.selector}` : m.selector;
    const tags =
      (m.selector === opts.current ? '  ← 当前' : '') +
      (m.selector === opts.defaultModel ? '  · 默认' : '');
    options.push(plainOption(`${mark(m.provider)}${base}${tags}`, m.selector));
  }
  options.push(plainOption('（默认 · 由 OMP 配置决定）', OMP_DEFAULT_MODEL_VALUE));

  const initial_option =
    opts.current && options.some((o) => o.value === opts.current)
      ? opts.current
      : OMP_DEFAULT_MODEL_VALUE;

  return {
    schema: '2.0',
    config: { summary: { content: '切换模型' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '当前模型：`' +
            (opts.current ?? opts.defaultModel ?? '(由 OMP 配置决定)') +
            '`\n选择模型后点「切换」生效。',
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'switch_form',
          elements: [
            {
              tag: 'select_static',
              name: 'model',
              initial_option,
              options,
            },
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: 'small',
              columns: [
                button('switch_btn', '切换', 'switch.confirm', 'primary'),
                button('cancel_btn', '取消', 'switch.cancel'),
              ],
            },
          ],
        },
      ],
    },
  };
}

function button(name: string, content: string, cmd: string, type?: 'primary'): object {
  const btn: Record<string, unknown> = {
    tag: 'button',
    name,
    text: { tag: 'plain_text', content },
    behaviors: [{ type: 'callback', value: { cmd } }],
  };
  if (type) btn.type = type;
  if (cmd.endsWith('.confirm')) btn.form_action_type = 'submit';
  return { tag: 'column', width: 'auto', elements: [btn] };
}

export function switchModelSavedCard(model?: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '模型已切换' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: model
            ? '✅ 已切换到模型：`' + model + '`\n下一条消息开始生效。'
            : '✅ 已恢复为 OMP 默认模型（不再传 --model）。\n下一条消息开始生效。',
        },
      ],
    },
  };
}

export function switchModelCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消，模型未变更。' }],
    },
  };
}
