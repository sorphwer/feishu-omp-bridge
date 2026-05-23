# feishu-codex-bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `feishu-codex-bridge`, a lightweight fork of `feishu-claude-code-bridge` whose Feishu/Lark behavior stays the same while the local Agent is Codex via `codex exec --json` and `codex exec resume --json <thread_id>`.

**Architecture:** Copy the proven TypeScript bridge shell, isolate runtime data under `~/.feishu-codex-bridge`, delete Claude-specific Agent code, add a Codex JSONL translator plus `CodexAdapter`, then wire Codex into the existing queue/session/card flow. Keep the existing `AgentAdapter` boundary so bot/channel, commands, cards, workspace storage, media, and daemon support remain stable.

**Tech Stack:** Node.js 20+, TypeScript, pnpm, Vitest, tsup, `@larksuiteoapi/node-sdk`, Codex CLI.

---

## File Structure

Create/modify these files in `/Users/joe/projects/misc/feishu/feishu-codex-bridge`:

- Copy from `../feishu-claude-code-bridge/`: all project source except `.git`, `node_modules`, and `dist`.
- Preserve existing design docs under `docs/superpowers/`.
- Create: `src/agent/codex/jsonl.ts` — translates Codex JSONL events into bridge `AgentEvent`s.
- Create: `src/agent/codex/jsonl.test.ts` — Codex JSONL translator tests.
- Create: `src/agent/codex/args.ts` — builds Codex CLI args and bridge prompt prefix.
- Create: `src/agent/codex/args.test.ts` — Codex CLI arg tests.
- Create: `src/agent/codex/adapter.ts` — implements `AgentAdapter` by spawning Codex.
- Modify: `src/agent/index.ts` — export `CodexAdapter` instead of `ClaudeAdapter`.
- Modify: `src/agent/types.ts` — add optional `imagePaths` to `AgentRunOptions`.
- Delete: `src/agent/claude/` — obsolete Claude adapter.
- Modify: `src/config/paths.ts` — use `~/.feishu-codex-bridge`.
- Modify: `src/config/schema.ts` — add Codex preference getters.
- Modify: `src/cli/commands/start.ts` and `src/cli/commands/service.ts` — instantiate/report Codex.
- Modify: `src/bot/channel.ts` — pass image paths and current configured Codex model into `agent.run()`.
- Modify: `src/card/dispatcher.ts` — rename callback marker from `__claude_cb` to `__codex_cb` and forward to Codex.
- Modify: `src/card/templates.ts` — remove hidden Claude-only `/resume` affordance and update help text to Codex.
- Modify: `src/commands/index.ts` — remove hidden Claude session-history `/resume`, update `/doctor` to Codex wording.
- Delete or stop importing: `src/session/history.ts` — Claude `.jsonl` session browser is not valid for Codex first version.
- Modify: branding/user-facing text in `src/**`, `README.md`, `README.zh.md`, `package.json`, `bin/`.

---

### Task 1: Scaffold the TypeScript bridge and rename package/CLI/data roots

**Files:**
- Copy: `../feishu-claude-code-bridge/**` → current repo
- Modify: `package.json`
- Create: `bin/feishu-codex-bridge.mjs`
- Delete: `bin/lark-channel-bridge.mjs`
- Modify: `src/cli/index.ts`
- Modify: `src/config/paths.ts`
- Modify: `src/daemon/paths.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Copy the source project without deleting approved specs/plans**

Run:

```bash
rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  ../feishu-claude-code-bridge/ ./
```

Expected: source files, package files, README files, and lockfile appear in the current repo; existing `docs/superpowers/**` files remain present.

- [ ] **Step 2: Rename the package manifest and bin entry**

Replace `package.json` with this content:

```json
{
  "name": "feishu-codex-bridge",
  "version": "0.1.0",
  "description": "Bridge Feishu/Lark messenger with the local Codex CLI",
  "type": "module",
  "bin": {
    "feishu-codex-bridge": "./bin/feishu-codex-bridge.mjs"
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist",
    "bin",
    "README.md",
    "README.zh.md",
    "LICENSE"
  ],
  "scripts": {
    "dev": "tsup --watch",
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "prepublishOnly": "pnpm typecheck && pnpm build"
  },
  "dependencies": {
    "@clack/prompts": "^1.4.0",
    "@larksuiteoapi/node-sdk": "^1.65.0",
    "commander": "^12.1.0",
    "https-proxy-agent": "^9.0.0",
    "qrcode-terminal": "^0.12.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/qrcode-terminal": "^0.12.2",
    "tsup": "^8.3.5",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "pnpm": {
    "onlyBuiltDependencies": [
      "esbuild",
      "protobufjs"
    ]
  },
  "keywords": [
    "feishu",
    "lark",
    "codex",
    "codex-cli",
    "cli",
    "channel",
    "bridge"
  ],
  "license": "MIT"
}
```

- [ ] **Step 3: Rename the executable shim**

Run:

```bash
rm -f bin/lark-channel-bridge.mjs
cat > bin/feishu-codex-bridge.mjs <<'SH'
#!/usr/bin/env node
import '../dist/cli.js';
SH
chmod +x bin/feishu-codex-bridge.mjs
```

Expected: `bin/feishu-codex-bridge.mjs` exists and is executable.

- [ ] **Step 4: Update CLI name and keystore help text**

In `src/cli/index.ts`:

```ts
program
  .name('feishu-codex-bridge')
  .description('Bridge Feishu/Lark messenger with the local Codex CLI')
  .version(pkg.version, '-v, --version');
```

Also change the `secrets` command description to:

```ts
.description('Manage the bridge\'s encrypted secret keystore (~/.feishu-codex-bridge/secrets.enc)');
```

Leave `lark-cli config bind --source lark-channel` text untouched in preflight logic for this task; it is an external `lark-cli` source identifier, not this package name.

- [ ] **Step 5: Update data paths**

Replace `src/config/paths.ts` with:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

const appDir = join(homedir(), '.feishu-codex-bridge');

export const paths = {
  appDir,
  cacheDir: appDir,
  configFile: join(appDir, 'config.json'),
  sessionsFile: join(appDir, 'sessions.json'),
  workspacesFile: join(appDir, 'workspaces.json'),
  processesFile: join(appDir, 'processes.json'),
  secretsFile: join(appDir, 'secrets.enc'),
  keystoreSaltFile: join(appDir, '.keystore.salt'),
  secretsGetterScript: join(appDir, 'secrets-getter'),
  mediaDir: join(appDir, 'media'),
};

export const legacyPaths = {
  appDir: join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'feishu-codex-bridge',
  ),
  cacheDir: join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
    'feishu-codex-bridge',
  ),
};
```

- [ ] **Step 6: Update service identity paths**

In `src/daemon/paths.ts`, set these constants:

```ts
export const SERVICE_NAME = 'feishu-codex-bridge.bot';
export const LAUNCH_AGENT_LABEL = `ai.${SERVICE_NAME}`;
export const SYSTEMD_UNIT_NAME = `${SERVICE_NAME}.service`;
export const WINDOWS_TASK_NAME = 'FeishuCodexBridge.Bot';
```

Keep existing helper functions, but ensure daemon stdout/stderr still use `paths.appDir` via `daemonLogDir()`.

- [ ] **Step 7: Install dependencies**

Run:

```bash
pnpm install
```

Expected: dependencies install and `node_modules/` is created.

- [ ] **Step 8: Verify scaffold compiles before Codex changes**

Run:

```bash
pnpm typecheck
```

Expected: PASS. If this fails because of a copy/rename typo, fix the typo before continuing; do not proceed with Codex implementation on a broken scaffold.

- [ ] **Step 9: Commit scaffold**

Run:

```bash
git add package.json pnpm-lock.yaml bin src .gitignore README.md README.zh.md LICENSE tsconfig.json tsup.config.ts
git commit -m "chore: scaffold feishu codex bridge"
```

---

### Task 2: Remove stale Claude-facing product paths and user text

**Files:**
- Delete: `src/agent/claude/`
- Modify: `src/agent/index.ts`
- Modify: `src/card/dispatcher.ts`
- Modify: `src/card/templates.ts`
- Modify: `src/commands/index.ts`
- Modify: `src/bot/group.ts`
- Modify: `src/bot/comments.ts`
- Modify: `src/bot/channel.ts`
- Modify: `src/bot/process-pool.ts`
- Modify: `src/bot/interactive-card.ts`
- Modify: `src/bot/quote.ts`
- Modify: `src/bot/reaction.ts`
- Modify: `src/core/logger.ts`
- Modify: `src/config/store.ts`
- Modify: `src/config/keystore.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/cli/commands/ps.ts`
- Modify: `src/cli/commands/secrets.ts`
- Modify: `src/cli/commands/service.ts`
- Modify: `src/cli/commands/start.ts`
- Modify: `src/cli/preflight.ts`

- [ ] **Step 1: Delete Claude adapter directory**

Run:

```bash
rm -rf src/agent/claude
```

- [ ] **Step 2: Replace agent export with a future Codex export placeholder**

Replace `src/agent/index.ts` with:

```ts
export type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from './types';
export { CodexAdapter } from './codex/adapter';
```

This will fail until Task 5 creates `src/agent/codex/adapter.ts`; that is expected after Step 2. Do not run typecheck until the task asks for it.

- [ ] **Step 3: Rename agent-created card callback marker**

In `src/card/dispatcher.ts`:

- Rename `CLAUDE_CALLBACK_MARKER` to `CODEX_CALLBACK_MARKER`.
- Change marker string from `__claude_cb` to `__codex_cb`.
- Rename `forwardToClaude` to `forwardToCodex`.
- Rename local `claudePayload` variable to `codexPayload`.
- Change log event from `forward-claude` to `forward-codex`.

Expected semantic behavior: card callbacks created by Codex are still converted into `[card-click] {...}` synthetic messages and queued into the same scope.

- [ ] **Step 4: Remove hidden Claude `.jsonl` session-history command**

In `src/commands/index.ts`:

- Remove `/resume: handleResume` from the `handlers` map.
- Remove imports `formatRelTime` and `listRecentSessions` from `../session/history`.
- Delete functions `handleResume` and `applyResume`.

Rationale: original `/resume` browses `~/.claude/projects/<cwd>/*.jsonl`, which is invalid for Codex. Automatic per-chat Codex thread resume remains implemented by `SessionStore`.

- [ ] **Step 5: Remove `/resume` buttons and help rows**

In `src/card/templates.ts`:

- In `statusCard`, remove the `🔁 恢复会话` button.
- Delete `ResumeEntry` interface and `resumeCard()` if nothing imports them after Step 4.
- In `helpCard`, remove the `/resume [N]` line and the `🔁 恢复会话` action button.
- Change `/doctor` help text to `把日志和描述交给 Codex 自助诊断`.
- Change final help text from `其他内容直接交给 Claude。` to `其他内容直接交给 Codex。`.

- [ ] **Step 6: Update obvious user-facing Claude text to Codex**

Make these targeted replacements:

```bash
python3 - <<'PY'
from pathlib import Path
replacements = {
    'Claude Code': 'Codex',
    'Claude': 'Codex',
    'claude 子进程': 'Codex 子进程',
    'claude runs': 'Codex runs',
    'claude run': 'Codex run',
    'claude subprocess': 'Codex subprocess',
    'claude': 'Codex',
    'Anthropic': 'OpenAI',
    'lark-channel-bridge': 'feishu-codex-bridge',
    '~/.lark-channel': '~/.feishu-codex-bridge',
}
for path in Path('src').rglob('*.ts'):
    text = path.read_text()
    updated = text
    for old, new in replacements.items():
        updated = updated.replace(old, new)
    if updated != text:
        path.write_text(updated)
PY
```

After this script, manually inspect and fix places where lowercase `claude` became awkward `Codex` in identifiers or comments. Identifiers that must be valid TypeScript should use `codex`, `Codex`, or neutral `agent` naming.

- [ ] **Step 7: Restore external `lark-cli` source string if the script changed it**

Run:

```bash
rg -n "--source" src/cli/preflight.ts src/config/schema.ts src/config/store.ts
```

Expected: command examples still say `lark-cli config bind --source lark-channel --identity bot-only`. This is intentionally kept because it is the external source identifier supported by `lark-cli`.

- [ ] **Step 8: Verify no obsolete user-visible Claude markers remain**

Run:

```bash
rg -n "Claude|claude|Anthropic|__claude_cb|\.claude|lark-channel-bridge|\.lark-channel" src package.json bin README.md README.zh.md || true
```

Expected: no matches. If matches remain, update them unless they are in an intentionally quoted historical changelog line; this project should not ship historical Claude changelog text.

- [ ] **Step 9: Commit cleanup**

Run:

```bash
git add src package.json bin README.md README.zh.md
git commit -m "chore: remove claude-specific bridge surface"
```

---

### Task 3: Add Codex JSONL translator with tests first

**Files:**
- Create: `src/agent/codex/jsonl.test.ts`
- Create: `src/agent/codex/jsonl.ts`

- [ ] **Step 1: Write failing translator tests**

Create `src/agent/codex/jsonl.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseCodexJsonLine, translateCodexEvent } from './jsonl';

function events(raw: unknown) {
  return [...translateCodexEvent(raw)];
}

describe('parseCodexJsonLine', () => {
  it('parses valid JSON lines', () => {
    expect(parseCodexJsonLine('{"type":"turn.started"}')).toEqual({ type: 'turn.started' });
  });

  it('returns undefined for non-JSON lines', () => {
    expect(parseCodexJsonLine('Reading additional input from stdin...')).toBeUndefined();
  });
});

describe('translateCodexEvent', () => {
  it('maps thread.started to a system session event', () => {
    expect(events({ type: 'thread.started', thread_id: 'thread-1' })).toEqual([
      { type: 'system', sessionId: 'thread-1' },
    ]);
  });

  it('maps agent messages to text deltas', () => {
    expect(events({ type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'hello' } })).toEqual([
      { type: 'text', delta: 'hello' },
    ]);
  });

  it('maps command execution start and completion to tool events', () => {
    expect(events({
      type: 'item.started',
      item: { id: 'item-1', type: 'command_execution', command: '/bin/zsh -lc pwd' },
    })).toEqual([
      {
        type: 'tool_use',
        id: 'item-1',
        name: 'command_execution',
        input: { command: '/bin/zsh -lc pwd' },
      },
    ]);

    expect(events({
      type: 'item.completed',
      item: {
        id: 'item-1',
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        aggregated_output: '/tmp\n',
        exit_code: 0,
      },
    })).toEqual([
      { type: 'tool_result', id: 'item-1', output: '/tmp\n', isError: false },
    ]);
  });

  it('marks non-zero command exit as tool error', () => {
    expect(events({
      type: 'item.completed',
      item: {
        id: 'item-1',
        type: 'command_execution',
        aggregated_output: 'boom\n',
        exit_code: 2,
      },
    })).toEqual([
      { type: 'tool_result', id: 'item-1', output: 'boom\n', isError: true },
    ]);
  });

  it('maps turn.completed to usage and done', () => {
    expect(events({
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    })).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 5 },
      { type: 'done' },
    ]);
  });

  it('maps explicit error events to errors', () => {
    expect(events({ type: 'error', message: 'bad' })).toEqual([
      { type: 'error', message: 'bad' },
    ]);
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm test src/agent/codex/jsonl.test.ts
```

Expected: FAIL because `src/agent/codex/jsonl.ts` does not exist.

- [ ] **Step 3: Implement translator**

Create `src/agent/codex/jsonl.ts`:

```ts
import type { AgentEvent } from '../types';

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
}

interface CodexRawEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  message?: string;
  error?: string | { message?: string };
}

export function parseCodexJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function* translateCodexEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as CodexRawEvent;

  switch (evt.type) {
    case 'thread.started':
      if (evt.thread_id) yield { type: 'system', sessionId: evt.thread_id };
      return;
    case 'item.started':
      yield* translateItemStarted(evt.item);
      return;
    case 'item.completed':
      yield* translateItemCompleted(evt.item);
      return;
    case 'turn.completed':
      if (evt.usage) {
        yield {
          type: 'usage',
          inputTokens: evt.usage.input_tokens,
          outputTokens: evt.usage.output_tokens,
        };
      }
      yield { type: 'done' };
      return;
    case 'error':
      yield { type: 'error', message: errorMessage(evt) };
      return;
    default:
      return;
  }
}

function* translateItemStarted(item: CodexItem | undefined): Generator<AgentEvent> {
  if (!item?.id || !item.type) return;
  if (item.type !== 'command_execution') return;
  yield {
    type: 'tool_use',
    id: item.id,
    name: item.type,
    input: { command: item.command ?? '' },
  };
}

function* translateItemCompleted(item: CodexItem | undefined): Generator<AgentEvent> {
  if (!item?.id || !item.type) return;

  if (item.type === 'agent_message') {
    if (item.text) yield { type: 'text', delta: item.text };
    return;
  }

  if (item.type === 'command_execution') {
    yield {
      type: 'tool_result',
      id: item.id,
      output: item.aggregated_output ?? '',
      isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
    };
    return;
  }

  if (item.text) {
    yield { type: 'text', delta: item.text };
  }
}

function errorMessage(evt: CodexRawEvent): string {
  if (typeof evt.message === 'string' && evt.message) return evt.message;
  if (typeof evt.error === 'string' && evt.error) return evt.error;
  if (evt.error && typeof evt.error === 'object' && evt.error.message) return evt.error.message;
  return 'codex emitted an error event';
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
pnpm test src/agent/codex/jsonl.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit translator**

Run:

```bash
git add src/agent/codex/jsonl.ts src/agent/codex/jsonl.test.ts
git commit -m "feat: translate codex json events"
```

---

### Task 4: Add Codex CLI argument builder with tests first

**Files:**
- Create: `src/agent/codex/args.test.ts`
- Create: `src/agent/codex/args.ts`
- Modify: `src/agent/types.ts`

- [ ] **Step 1: Extend AgentRunOptions for image paths**

In `src/agent/types.ts`, add this optional field to `AgentRunOptions`:

```ts
  /** Local image paths to pass to agents that support native image flags. */
  imagePaths?: string[];
```

Keep existing fields unchanged.

- [ ] **Step 2: Write failing arg builder tests**

Create `src/agent/codex/args.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildCodexArgs, buildCodexPrompt } from './args';

describe('buildCodexPrompt', () => {
  it('prepends bridge run conventions to the user prompt', () => {
    const prompt = buildCodexPrompt('hello');
    expect(prompt).toContain('# feishu-codex-bridge 运行约定');
    expect(prompt).toContain('hello');
    expect(prompt).toContain('<bridge_context>');
    expect(prompt).toContain('__codex_cb');
  });
});

describe('buildCodexArgs', () => {
  it('builds new-thread codex exec args with cwd', () => {
    const args = buildCodexArgs({ prompt: 'hello', cwd: '/repo' });
    expect(args.slice(0, 6)).toEqual(['exec', '--json', '--skip-git-repo-check', '-C', '/repo', '--dangerously-bypass-approvals-and-sandbox']);
    expect(args.at(-1)).toContain('hello');
  });

  it('builds resume args without unsupported -C', () => {
    const args = buildCodexArgs({ prompt: 'continue', cwd: '/repo', sessionId: 'thread-1' });
    expect(args.slice(0, 4)).toEqual(['exec', 'resume', '--json', '--dangerously-bypass-approvals-and-sandbox']);
    expect(args).toContain('thread-1');
    expect(args).not.toContain('-C');
  });

  it('passes model and images before the prompt', () => {
    const args = buildCodexArgs({
      prompt: 'look',
      cwd: '/repo',
      model: 'gpt-5.1',
      imagePaths: ['/tmp/a.png', '/tmp/b.jpg'],
    });
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5.1');
    expect(args).toContain('--image');
    expect(args).toContain('/tmp/a.png');
    expect(args).toContain('/tmp/b.jpg');
  });

  it('does not add bypass flag outside bypassPermissions mode', () => {
    const args = buildCodexArgs({ prompt: 'safe', cwd: '/repo', permissionMode: 'default' });
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
pnpm test src/agent/codex/args.test.ts
```

Expected: FAIL because `src/agent/codex/args.ts` does not exist.

- [ ] **Step 4: Implement arg builder**

Create `src/agent/codex/args.ts`:

```ts
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
```

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
pnpm test src/agent/codex/args.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit arg builder**

Run:

```bash
git add src/agent/types.ts src/agent/codex/args.ts src/agent/codex/args.test.ts
git commit -m "feat: build codex cli arguments"
```

---

### Task 5: Implement CodexAdapter process execution

**Files:**
- Create: `src/agent/codex/adapter.ts`
- Modify: `src/agent/index.ts`

- [ ] **Step 1: Write implementation**

Create `src/agent/codex/adapter.ts`:

```ts
import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { buildCodexArgs } from './args';
import { parseCodexJsonLine, translateCodexEvent } from './jsonl';

export interface CodexAdapterOptions {
  binary?: string;
}

type CodexChild = ChildProcessByStdio<null, Readable, Readable>;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';

  private readonly binary: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.binary = opts.binary ?? 'codex';
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    const args = buildCodexArgs(opts);
    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        LARK_CHANNEL: process.env.LARK_CHANNEL ?? '1',
        FEISHU_CODEX_BRIDGE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      imageCount: opts.imagePaths?.length ?? 0,
    });

    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: CodexChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn codex: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const parsed = parseCodexJsonLine(line);
      if (parsed === undefined) {
        if (line.trim()) log.warn('agent', 'non-json-stdout', { line });
        continue;
      }
      yield* translateCodexEvent(parsed);
    }
  } finally {
    rl.close();
  }

  const exit = await waitForExit(child);
  const runtimeError = getError();
  if (exit.code !== 0 && exit.signal === null) {
    const detail = stderrChunks.length > 0 ? `: ${Buffer.concat(stderrChunks).toString('utf8').trim()}` : '';
    yield { type: 'error', message: `codex exited with code ${exit.code}${detail}` };
  } else if (runtimeError) {
    yield { type: 'error', message: `codex runtime error: ${runtimeError.message}` };
  }
}

function waitForExit(child: CodexChild): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
```

- [ ] **Step 2: Verify focused tests**

Run:

```bash
pnpm test src/agent/codex/jsonl.test.ts src/agent/codex/args.test.ts
```

Expected: PASS.

- [ ] **Step 3: Verify typecheck reaches adapter**

Run:

```bash
pnpm typecheck
```

Expected: FAIL only if remaining code still imports deleted Claude adapter or has rename mistakes. Fix those mistakes now.

- [ ] **Step 4: Commit adapter**

Run after typecheck is passing:

```bash
git add src/agent src/core src/cli src/bot src/card src/commands src/config
git commit -m "feat: run codex as bridge agent"
```

---

### Task 6: Wire Codex config, model, images, and startup checks

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/bot/channel.ts`
- Modify: `src/cli/commands/start.ts`
- Modify: `src/cli/commands/service.ts`

- [ ] **Step 1: Add Codex preference fields and getters**

In `src/config/schema.ts`, add to `AppPreferences`:

```ts
  /** Codex executable name or path. Default: codex. */
  codexBinary?: string;
  /** Optional Codex model passed as `-m`. Empty means Codex config decides. */
  codexModel?: string;
```

Add these functions near the other preference getters:

```ts
export function getCodexBinary(cfg: AppConfig): string {
  const raw = cfg.preferences?.codexBinary;
  if (typeof raw !== 'string' || raw.trim() === '') return 'codex';
  return raw.trim();
}

export function getCodexModel(cfg: AppConfig): string | undefined {
  const raw = cfg.preferences?.codexModel;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return raw.trim();
}
```

- [ ] **Step 2: Pass image paths and model into runs**

In `src/bot/channel.ts`, import `getCodexModel` from config schema.

Inside `runAgentBatch`, after resolving `attachments`, add:

```ts
  const imagePaths = attachments
    .filter((a) => a.kind === 'image')
    .map((a) => a.path);
```

Change the `agent.run` call to include:

```ts
    model: getCodexModel(controls.cfg),
    imagePaths,
```

Expected final call shape:

```ts
  const run = agent.run({
    prompt,
    sessionId: resumeFrom,
    cwd,
    model: getCodexModel(controls.cfg),
    imagePaths,
    stopGraceMs: getAgentStopGraceMs(controls.cfg),
  });
```

- [ ] **Step 3: Use CodexAdapter in foreground start**

In `src/cli/commands/start.ts`:

- Replace `ClaudeAdapter` import with `CodexAdapter`.
- Import `getCodexBinary`.
- Instantiate:

```ts
  const agent = new CodexAdapter({ binary: getCodexBinary(cfg) });
```

- Replace availability error with:

```ts
    console.error('✗ 未找到 codex CLI。请先安装并登录 Codex：');
    console.error('  codex login');
```

- [ ] **Step 4: Use CodexAdapter in service status reporting**

In `src/cli/commands/service.ts`:

- Replace `ClaudeAdapter` import with `CodexAdapter`.
- Replace `new ClaudeAdapter()` with `new CodexAdapter()` for display reporting.

- [ ] **Step 5: Run verification**

Run:

```bash
pnpm typecheck
pnpm test
```

Expected: both PASS.

- [ ] **Step 6: Commit wiring**

Run:

```bash
git add src/config/schema.ts src/bot/channel.ts src/cli/commands/start.ts src/cli/commands/service.ts
git commit -m "feat: wire codex runtime preferences"
```

---

### Task 7: Rewrite README files for the Codex bridge

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`

- [ ] **Step 1: Replace `README.zh.md` with Codex-specific user docs**

Use the original README structure, but ensure these facts are explicit:

```md
# feishu-codex-bridge

把飞书 / Lark 消息和本地 Codex CLI 打通的轻量 bot。它沿用飞书 Claude Code Bridge 的聊天体验，但真正执行的是 `codex exec --json`。

## 能干什么

- 在飞书私聊直接发消息，或在群里 `@bot`，把消息转给本地 Codex CLI。
- 流式卡片展示 Codex 文本、命令执行和工具输出。
- 每个 chat / topic 保存自己的 Codex thread id，下一轮自动 `codex exec resume --json <thread_id>`。
- `/new`、`/cd`、`/ws`、`/status`、`/config`、`/stop` 等命令与原 bridge 保持一致。
- 图片 / 文件会下载到本地路径；图片同时通过 `--image` 传给 Codex。

## 前置条件

- Node.js >= 20
- `codex` CLI 已安装并登录：`codex login`
- 一个飞书 / Lark PersonalAgent 应用；首次启动向导会协助配置。

## 启动

```bash
feishu-codex-bridge run
```

## 数据目录

- `~/.feishu-codex-bridge/config.json`
- `~/.feishu-codex-bridge/sessions.json`
- `~/.feishu-codex-bridge/workspaces.json`
- `~/.feishu-codex-bridge/processes.json`
- `~/.feishu-codex-bridge/media/`
- `~/.feishu-codex-bridge/logs/`

## 和 codex-remote-feishu 的区别

本项目是轻量聊天桥，适合把飞书消息直接交给本机 Codex CLI。需要完整远程接管、VS Code 跟随、daemon/app-server 协议和后台 thread 管理时，请使用 `codex-remote-feishu`。
```

Then preserve the detailed command table from the original README, replacing Claude wording with Codex and removing `/resume`.

- [ ] **Step 2: Replace `README.md` with English equivalent**

Mirror `README.zh.md` in English. Include the same prerequisites, commands, data directory, and distinction from `codex-remote-feishu`.

- [ ] **Step 3: Verify docs contain no obsolete Claude branding**

Run:

```bash
rg -n "Claude|claude|Anthropic|lark-channel-bridge|\.lark-channel" README.md README.zh.md package.json src || true
```

Expected: no matches.

- [ ] **Step 4: Commit docs**

Run:

```bash
git add README.md README.zh.md
git commit -m "docs: describe codex bridge usage"
```

---

### Task 8: Final validation and real Codex smoke test

**Files:**
- Modify if needed: any file exposed by validation failures

- [ ] **Step 1: Run static checks**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 2: Run tests**

Run with a 60-second timeout:

```bash
timeout 60 pnpm test
```

On macOS without GNU `timeout`, run:

```bash
python3 - <<'PY'
import subprocess, sys
try:
    cp = subprocess.run(['pnpm', 'test'], timeout=60)
except subprocess.TimeoutExpired:
    print('pnpm test timed out after 60s', file=sys.stderr)
    sys.exit(124)
sys.exit(cp.returncode)
PY
```

Expected: PASS.

- [ ] **Step 3: Build**

Run:

```bash
pnpm build
```

Expected: PASS and `dist/cli.js` plus `dist/index.js` are produced.

- [ ] **Step 4: Run real Codex JSON smoke test**

Run:

```bash
codex exec --json --ephemeral --skip-git-repo-check -C /tmp 'Reply exactly: ping'
```

Expected stdout includes JSONL events similar to:

```json
{"type":"thread.started","thread_id":"..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"ping"}}
{"type":"turn.completed", ...}
```

If Codex reports auth/config errors, do not mock success; report the exact error and stop for user action.

- [ ] **Step 5: Run bridge CLI help smoke test**

Run:

```bash
node ./dist/cli.js --help
```

Expected: help output names `feishu-codex-bridge` and lists `run`, `ps`, `kill`, `start`, `stop`, `restart`, `status`, `unregister`, and `secrets`.

- [ ] **Step 6: Inspect git status**

Run:

```bash
git status --short
```

Expected: only intentional final edits, or clean if all validation fixes were already committed.

- [ ] **Step 7: Commit validation fixes or final state**

If validation required fixes:

```bash
git add <fixed-files>
git commit -m "fix: pass codex bridge validation"
```

If no fixes are pending, do not create an empty commit.

---

## Self-Review Notes

- Spec coverage: this plan implements the approved light fork, independent data directory, Codex JSONL mapping, Codex thread resume, `/stop` via real process termination, image argument passing, docs, and validation.
- Deliberate scope cut: hidden Claude-specific `/resume` history browsing is removed because it depends on `~/.claude/projects`. Automatic bridge session resume remains intact through Codex `thread_id`.
- No silent fallback: Codex spawn failures, non-zero exits, and auth/config errors are surfaced as errors. The plan does not introduce mock success paths.
