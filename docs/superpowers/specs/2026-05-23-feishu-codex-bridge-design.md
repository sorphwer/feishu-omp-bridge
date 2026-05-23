# feishu-codex-bridge 设计文档

日期：2026-05-23

## 1. 背景与目标

`feishu-codex-bridge` 是一个新的轻量飞书 / Lark bot 项目。目标是让它的产品行为与 `feishu-claude-code-bridge` 保持一致，但实际执行的本地 Agent 从 Claude Code 切换为 Codex。

已确认的实现路线是 **方案 A：轻量 fork + 替换 Agent 层**：

- 以 `feishu-claude-code-bridge` 的 TypeScript/Node 架构为基础。
- 保留飞书消息通道、命令体系、流式卡片、workspace/session/media/log/daemon 机制。
- 不接入 `codex-remote-feishu` 的 daemon/app-server 协议。
- Codex 执行接口使用 `codex exec --json` 和 `codex exec resume --json <thread_id>`。

## 2. 非目标

第一版明确不做以下事情：

- 不复刻 `codex-remote-feishu` 的 relay / wrapper / app-server / VS Code 跟随体系。
- 不新增 provider 管理 UI；Codex 登录、模型/provider 配置继续由本机 Codex 配置管理。
- 不引入 Claude / Codex 多 Agent provider 抽象；第一版只面向 Codex。
- 不添加 mock 成功路径，不吞掉 Codex 错误，不通过假回复绕过真实执行。

如果用户需要完整远程接管、VS Code 跟随、后台 thread 管理等能力，应继续使用 `codex-remote-feishu`。

## 3. 总体架构

项目从 `feishu-claude-code-bridge` 复制为独立 npm 包，并替换 Agent 边界：

```text
飞书 / Lark
  ↓
bot/channel.ts
  ↓
AgentAdapter interface
  ↓
CodexAdapter
  ↓
codex exec --json / codex exec resume --json <thread_id>
```

保留的核心模块包括：

- 飞书 WebSocket 接入与消息规范化。
- pending queue：快速连发合并成一次 Codex 请求。
- active run：同一 chat/topic scope 同时只运行一个 Codex 子进程。
- 流式卡片 / markdown / text 回复模式。
- 图片和文件下载到本地后注入 prompt。
- session 和 workspace 存储。
- 进程注册、前台运行、后台 daemon/service 管理。
- `/account`、`/config` 等飞书卡片表单。

主要替换模块：

```text
src/agent/claude/adapter.ts      -> src/agent/codex/adapter.ts
src/agent/claude/stream-json.ts  -> src/agent/codex/jsonl.ts
```

`src/agent/types.ts` 的 `AgentAdapter` / `AgentRun` / `AgentEvent` 接口尽量保持不变，避免大范围重写 bot/channel、card、commands 等模块。

## 4. 包名、命令名与数据目录

建议使用独立包名和命令名：

```text
package name: feishu-codex-bridge
bin: feishu-codex-bridge
```

数据目录与 Claude bridge 隔离，避免 session、workspace、进程注册和日志互相污染：

```text
~/.feishu-codex-bridge/config.json
~/.feishu-codex-bridge/sessions.json
~/.feishu-codex-bridge/workspaces.json
~/.feishu-codex-bridge/processes.json
~/.feishu-codex-bridge/media/
~/.feishu-codex-bridge/logs/
```

README 中需要明确：这是 Claude bridge 的 Codex 版本，而不是 `codex-remote-feishu` 的简化发行版。

## 5. CodexAdapter 设计

### 5.1 可用性检查

`CodexAdapter.isAvailable()` 执行：

```bash
codex --version
```

如果命令不存在或返回非 0，则启动前暴露明确错误，提示用户安装并登录 Codex CLI。

### 5.2 新会话启动

当当前 scope 没有可续用 thread id 时，启动新会话：

```bash
codex exec --json --skip-git-repo-check -C <cwd> <prompt>
```

实现上同时设置 `spawn({ cwd })`，让 shell/tool 工作目录和 Codex `-C` 保持一致。

### 5.3 续会话启动

当当前 scope 有已保存的 Codex thread id 时，续会话：

```bash
codex exec resume --json <thread_id> <prompt>
```

`codex exec resume --help` 当前不提供 `-C` 参数，因此续会话不强塞 `-C`。实现只通过 `spawn({ cwd })` 设置工作目录，并让 Codex 根据 thread id 恢复上下文。

### 5.4 参数映射

公共参数：

- `--json`：输出 JSONL 事件。
- `--skip-git-repo-check`：新会话允许在非 git 目录运行，保持原 Claude bridge 的宽松 cwd 体验。
- `-C <cwd>`：仅用于 `codex exec` 新会话。
- `-m <model>`：当配置提供 Codex model 时传入。
- `--image <path>`：图片附件映射为 Codex image 参数。

权限映射：

- `permissionMode === 'bypassPermissions'`：传 `--dangerously-bypass-approvals-and-sandbox`，使默认体验接近 Claude bridge。
- `permissionMode === 'default' | 'plan' | 'acceptEdits'`：第一版使用 Codex 默认配置或显式较保守参数，不静默降级。如果 Codex 拒绝或报错，错误直接进入日志和卡片。

### 5.5 停止行为

`run.stop()` 真实终止 Codex 子进程：

1. 发送 `SIGTERM`。
2. 等待 `stopGraceMs`。
3. 仍未退出则发送 `SIGKILL`。

不伪造“停止成功”。卡片最终状态由真实进程退出、事件流终止或错误驱动。

## 6. Codex JSONL 到 AgentEvent 的映射

`src/agent/codex/jsonl.ts` 负责把 Codex JSONL 事件翻译为现有 bridge 的 `AgentEvent`：

| Codex JSONL | AgentEvent | 说明 |
|---|---|---|
| `thread.started` | `system` | 保存 `thread_id` 为 `sessionId`。 |
| `turn.started` | 内部状态或 `thinking` | 可用于触发“正在执行”。不作为用户正文。 |
| `item.started` + `command_execution` | `tool_use` | `name = "command_execution"`，`input.command` 保存命令。 |
| `item.completed` + `command_execution` | `tool_result` | `aggregated_output` 为输出，`exit_code !== 0` 为错误。 |
| `item.completed` + `agent_message` | `text` | `item.text` 作为 assistant 文本。 |
| `turn.completed` | `usage` + `done` | 保存 usage，并标记本轮完成。 |
| 非 JSON 行 | 忽略并记录 debug | 不作为成功事件。 |
| Codex 进程非零退出 | `error` | 暴露 stderr / exit code。 |

未识别但结构化的 item 第一版遵循“清晰可见”原则：

- 明确是文本的，映射为 `text`。
- 明确是工具或外部动作的，映射为 `tool_use` / `tool_result`。
- 无法确定语义的，写入日志，不伪造完成状态。

## 7. Session 与 workspace 语义

沿用原 `SessionStore` 和 `WorkspaceStore` 的对外语义，但 `sessionId` 改指 Codex `thread_id`。

- 收到 `thread.started.thread_id` 时，保存到当前 scope + cwd。
- 同一 chat/topic scope 下，后续消息用保存的 thread id 执行 `codex exec resume`。
- `/new` / `/reset`：中断当前 run 并清理当前 scope 的 thread id。
- `/cd <path>`：切换 cwd，清理当前 scope 的 thread id。
- `/ws use <name>`：切换 workspace，清理当前 scope 的 thread id。
- `/status`：显示当前 cwd、Codex thread id、Agent 名称和 scope。

当 session 的 cwd 与当前 workspace cwd 不一致时，保持原项目行为：视为 stale，清理后新开 Codex thread。

## 8. 飞书命令与产品行为

第一版保留 Claude bridge 的命令集，并把用户可见文案改为 Codex：

- `/new`、`/reset`
- `/cd <path>`
- `/ws list|save|use|remove`
- `/status`
- `/config`
- `/stop`
- `/timeout`
- `/ps`
- `/exit`
- `/reconnect`
- `/doctor`
- `/help`
- `/account`

未知 `/xxx` 仍然原样交给 Codex，和 Claude bridge 保持一致。

`/doctor` 使用 Codex 分析最近 bridge 日志：

- p2p 中可以流式返回诊断卡。
- 群聊中先公开 ack，再将诊断结果私信给操作者。
- 不使用 mock 诊断，不隐藏日志读取或 Codex 执行错误。

## 9. 配置设计

配置结构尽量沿用原项目，避免重写 `/config` 表单和启动逻辑。

保留字段：

- `accounts.app`
- `preferences.messageReply`
- `preferences.showToolCalls`
- `preferences.maxConcurrentRuns`
- `preferences.runIdleTimeoutMinutes`
- `preferences.requireMentionInGroup`
- `preferences.access`
- `preferences.agentStopGraceMs`

新增可选字段：

```ts
preferences.codexBinary?: string;   // 默认 "codex"
preferences.codexModel?: string;    // 映射 -m
preferences.codexSandbox?: string;  // 仅当后续明确需要时使用
```

第一版不新增 provider 管理 UI。Codex 认证、provider、profile 等配置继续由用户的 Codex CLI 配置负责。

## 10. 文档更新

README 需要覆盖：

- 项目定位：Claude bridge 的 Codex 版本。
- 前置条件：Node.js >= 20，`codex` CLI 已安装并登录。
- 首次启动和扫码绑定飞书 PersonalAgent。
- 命令速查。
- 数据目录变更为 `~/.feishu-codex-bridge/`。
- 会话 ID 是 Codex thread id。
- 和 `codex-remote-feishu` 的区别：本项目是轻量聊天桥，后者是完整远程接管系统。

## 11. 测试与验证

### 11.1 单元测试

新增 Codex JSONL 解析测试：

- `thread.started` 产生 `system(sessionId)`。
- `item.completed` 的 `agent_message` 产生 `text`。
- `command_execution` 的 started/completed 产生 tool use/result。
- `turn.completed` 产生 `usage` 和 `done`。
- 非 JSON 行不产生成功事件。
- 非零退出映射为 `error`。

新增参数构造测试：

- 新会话使用 `codex exec --json --skip-git-repo-check -C <cwd> <prompt>`。
- 续会话使用 `codex exec resume --json <thread_id> <prompt>`，不传不支持的 `-C`。
- 图片附件映射到 `--image <path>`。
- `codexBinary` 可覆盖默认二进制。

### 11.2 自动化验证

实现完成后执行：

```bash
pnpm typecheck
pnpm test
pnpm build
```

后端测试按项目要求控制在 60 秒以内。

### 11.3 真实 smoke test

用本机真实 Codex CLI 验证 JSONL 行为：

```bash
codex exec --json --ephemeral --skip-git-repo-check -C /tmp 'Reply exactly: ping'
```

预期至少出现：

- `thread.started`
- `turn.started`
- `item.completed` / `agent_message`
- `turn.completed`

## 12. 成功标准

第一版完成后应满足：

1. `feishu-codex-bridge run` 能启动并监听飞书消息。
2. 飞书私聊发送文字后，真实 `codex exec --json` 被调用并返回结果。
3. 同一 chat/topic 第二轮能用保存的 Codex thread id 续聊。
4. `/stop` 能终止正在运行的 Codex 子进程。
5. `/cd`、`/ws`、`/status`、卡片流式渲染行为与 Claude bridge 保持一致。
6. Codex 错误会明确暴露到日志和卡片，不通过 fallback 或 mock 隐藏。
7. `pnpm typecheck`、`pnpm test`、`pnpm build` 通过。

## 13. 实施顺序概览

后续实施计划应按 TDD 拆分，建议顺序：

1. 初始化项目骨架，复制 Claude bridge 并完成包名/路径重命名。
2. 写 Codex JSONL 解析测试，再实现 `src/agent/codex/jsonl.ts`。
3. 写 CodexAdapter 参数构造和进程控制测试，再实现 `src/agent/codex/adapter.ts`。
4. 替换入口默认 Agent 为 Codex。
5. 调整 paths、README、用户文案和命令帮助。
6. 运行自动化验证和真实 Codex smoke test。
