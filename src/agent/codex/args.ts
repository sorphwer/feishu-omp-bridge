import type { AgentRunOptions } from '../types';

const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

export const CODEX_BRIDGE_PROMPT = `# feishu-codex-bridge 运行约定

你正在 feishu-codex-bridge 里运行：把飞书/Lark 用户消息桥到本地 \`codex\` CLI。

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

如果你用 \`lark-cli im send-card\` 发交互卡片，并希望用户点击按钮后回调到当前 Codex 会话，按钮的 \`value\` 对象必须包含 \`__codex_cb: true\`。用户点击后，bridge 会把 payload（去掉 \`__codex_cb\`）作为 \`[card-click] {...}\` 消息发回给你。

如果只是展示卡片，不要添加 \`__codex_cb\`。
`;

export interface BuildCodexArgsOptions extends AgentRunOptions {}

export function buildCodexPrompt(prompt: string): string {
  return `${CODEX_BRIDGE_PROMPT}\n---\n\n${prompt}`;
}

export function buildCodexArgs(opts: BuildCodexArgsOptions): string[] {
  const args = opts.sessionId
    ? ['exec', 'resume', '--json']
    : ['exec', '--json', '--skip-git-repo-check'];

  if (!opts.sessionId && opts.cwd) {
    args.push('-C', opts.cwd);
  }

  if ((opts.permissionMode ?? DEFAULT_PERMISSION_MODE) === 'bypassPermissions') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }

  if (opts.model) {
    args.push('-m', opts.model);
  }

  for (const imagePath of opts.imagePaths ?? []) {
    args.push('--image', imagePath);
  }

  if (opts.sessionId) {
    args.push(opts.sessionId);
  }

  args.push(buildCodexPrompt(opts.prompt));
  return args;
}
