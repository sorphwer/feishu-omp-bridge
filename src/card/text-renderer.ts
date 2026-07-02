import type { Block, RunState, ToolEntry, UiState } from './run-state';
import { toolHeaderText } from './tool-render';

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'markdown'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Tool calls collapse to a single short line each (no body)
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
export function renderText(state: RunState): string {
  const parts: string[] = [];

  // Markdown mode has no card header, so surface the profile/owner badge as a
  // top line — the markdown equivalent of renderCard's coloured header. Seeded
  // for group/topic runs only (p2p is single-party).
  const badge = badgeLine(state.badge);
  if (badge) parts.push(badge);

  const ui = renderUiContext(state.ui);
  if (ui) parts.push(ui);
  for (const block of state.blocks) {
    const piece = renderBlock(block);
    if (piece) parts.push(piece);
  }

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  } else if (state.terminal === 'running' && state.footer) {
    parts.push(footerLine(state.footer));
  }

  return parts.join('\n\n');
}

/**
 * Top profile badge for markdown mode, e.g. `🔒 **guest（受限）** · @张三`.
 * Colour isn't available in markdown, so trust is carried by the icon:
 * 🔓 unrestricted `full`, 🔒 a restricted sandbox, ⛔ fail-closed `locked`.
 */
function badgeLine(badge: RunState['badge']): string {
  if (!badge) return '';
  const locked = badge.profileName === 'locked' || badge.profileName.startsWith('locked(');
  const icon = locked ? '⛔' : badge.restricted ? '🔒' : '🔓';
  const label = badge.restricted && !locked ? `${badge.profileName}（受限）` : badge.profileName;
  const owner = badge.owner ? ` · @${badge.owner}` : '';
  return `${icon} **${label}**${owner}`;
}

function renderBlock(block: Block): string {
  if (block.kind === 'text') {
    return block.content.trim();
  }
  return toolLine(block.tool);
}

/**
 * One-line summary for a tool call:
 *   `> ⏳ **Bash** — git status`
 *   `> ✅ **Read** — ~/code/foo.ts`
 * Reuses `toolHeaderText` so the format matches the card mode header.
 */
function toolLine(tool: ToolEntry): string {
  return `> ${toolHeaderText(tool)}`;
}

function footerLine(status: 'thinking' | 'tool_running' | 'streaming' | 'waiting_input'): string {
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  if (status === 'waiting_input') return '_🧩 等待用户交互…_';
  return '_✍️ 正在输出…_';
}

function renderUiContext(ui: UiState): string {
  const lines: string[] = [];
  if (ui.title) lines.push(`- 标题：${ui.title}`);
  for (const [key, text] of Object.entries(ui.statuses)) lines.push(`- ${key}：${text}`);
  for (const [key, widget] of Object.entries(ui.widgets)) {
    lines.push(`- ${key}: ${(widget.lines ?? []).join(' / ')}`);
  }
  if (ui.editorText) lines.push(`- 编辑器内容：${ui.editorText.slice(0, 300)}`);
  return lines.length > 0 ? `> 🧩 OMP 状态\n${lines.join('\n')}` : '';
}
