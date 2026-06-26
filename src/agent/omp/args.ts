import type { AgentRunOptions } from '../types';

export const OMP_BRIDGE_PROMPT = `# feishu-omp-bridge 运行约定

你正在 feishu-omp-bridge 里运行：把飞书/Lark 用户消息桥到本地 \`omp --mode rpc\`。

## bridge_context

每条 user message 顶部会带一个 \`<bridge_context>\` 块：

\`\`\`
<bridge_context>
chat_id: oc_xxx
chat_type: p2p
sender_id: ou_xxx
sender_name: ...
</bridge_context>
\`\`\`

里面是当前对话的 chat_id、chat 类型（p2p / group）、发送者。这些是 bridge 注入的元数据，不要照抄、不要在回复里渲染。

## quoted_message

如果用户用“引用回复”指向某条消息，bridge 会在 \`<bridge_context>\` 后注入一个 \`<quoted_message>\` 块。用户的实际问题在它之后。回答时围绕被引用内容展开，不要照抄 XML 标签。

## interactive_card

用户发 / 引用交互卡片时，bridge 会把卡片 JSON 注入到 \`<interactive_card>\` 块。解析 JSON 理解按钮、字段和布局；不要照抄 XML 标签。

## 发交互卡片（按钮、表单）的回调约定

如果你用 \`lark-cli im send-card\` 发交互卡片，并希望用户点击按钮后回调到当前 OMP 会话，按钮的 \`value\` 对象必须包含兼容标记 \`__codex_cb: true\`。用户点击后，bridge 会把 payload（去掉 \`__codex_cb\`）作为 \`[card-click] {...}\` 消息发回给你。

如果只是展示卡片，不要添加 \`__codex_cb\`。
`;

export interface BuildOmpArgsOptions extends AgentRunOptions {
  sessionDir?: string;
  thinking?: string;
  tools?: string;
}

export function buildOmpPrompt(prompt: string): string {
  return `${OMP_BRIDGE_PROMPT}\n---\n\n${prompt}`;
}

export function buildOmpArgs(opts: BuildOmpArgsOptions): string[] {
  const args = ['--mode', 'rpc', '--no-title'];

  const sessionDir = clean(opts.sessionDir);
  if (sessionDir) args.push('--session-dir', sessionDir);

  const sessionId = clean(opts.sessionId);
  if (sessionId) args.push('--resume', sessionId);

  const model = clean(opts.model);
  if (model) args.push('--model', model);

  const thinking = clean(opts.thinking);
  if (thinking) args.push('--thinking', thinking);

  const tools = clean(opts.tools);
  if (tools) args.push('--tools', tools);

  for (const overlay of opts.configOverlayPaths ?? []) {
    const p = clean(overlay);
    if (p) args.push('--config', p);
  }

  for (const ext of opts.extensionPaths ?? []) {
    const p = clean(ext);
    if (p) args.push('--extension', p);
  }

  return args;
}

function clean(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
