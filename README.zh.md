# feishu-codex-bridge

把飞书 / Lark 消息和本地 Codex CLI 打通的轻量 bot。它沿用原有飞书聊天桥的使用体验，但真正执行的是 `codex exec --json`。

## 能干什么

- 在飞书私聊直接发消息，或在群里 `@bot`，把消息转给本地 Codex CLI。
- 流式卡片展示 Codex 文本、命令执行和工具输出。
- 每个 chat / topic 保存自己的 Codex thread id，下一轮自动 `codex exec resume --json <thread_id>`。
- `/new`、`/cd`、`/ws`、`/status`、`/config`、`/stop` 等命令与原 bridge 保持一致。
- 图片 / 文件会下载到本地路径；图片同时通过 `--image` 传给 Codex。
- Codex 可以继续使用本机可用的工具，例如 `lark-cli`、`git`、项目测试命令等。

## 前置条件

- Node.js >= 20
- pnpm（源码开发 / 本地构建时使用）
- `codex` CLI 已安装并登录：`codex login`
- 一个飞书 / Lark PersonalAgent 应用；首次启动向导会协助配置。

## 安装 / 构建

从源码运行：

```bash
pnpm install
pnpm build
node ./dist/cli.js --help
```

全局使用时，将包发布或链接后运行：

```bash
feishu-codex-bridge
```

不带子命令时默认等价于 `feishu-codex-bridge run`。

## 首次启动

```bash
feishu-codex-bridge
```

首次启动会检查配置并引导完成：

1. 选择飞书或 Lark 租户。
2. 输入 PersonalAgent 应用的 App ID / App Secret。
3. 按提示扫码或完成 `lark-cli` 绑定。
4. 凭据写入 `~/.feishu-codex-bridge/config.json`，密钥加密保存在本地 keystore。

## CLI 命令

### 前台进程

```bash
feishu-codex-bridge run [-c <config>]     前台启动 bot
feishu-codex-bridge ps                    列出本机所有正在跑的 bridge 进程
feishu-codex-bridge kill <id|#>           kill 指定 bridge 进程（SIGTERM，2s 后 SIGKILL）
feishu-codex-bridge secrets <subcommand>  管理本地加密 secret keystore
feishu-codex-bridge --help                列出所有命令
```

### 后台 daemon

> 服务层命令应使用全局安装或稳定路径下的可执行文件。daemon 的 launchd plist / systemd unit / Windows 任务会记录 CLI 路径；不要用会被临时缓存清理的 `npx` 路径注册后台服务。

```bash
feishu-codex-bridge start                 注册（如需）+ 启动后台 daemon
feishu-codex-bridge stop                  停止 daemon 并关闭开机自启
feishu-codex-bridge restart               重启 daemon
feishu-codex-bridge status                查看 daemon 状态（pid、日志路径、上次退出码）
feishu-codex-bridge unregister            撤销注册（停止 + 删除服务定义文件）
```

后台实现：

- macOS：`launchd` 用户代理 `~/Library/LaunchAgents/ai.feishu-codex-bridge.bot.plist`
- Linux：`systemd` 用户单元 `~/.config/systemd/user/feishu-codex-bridge.bot.service`
- Windows：Task Scheduler 任务 `FeishuCodexBridge.Bot`

## 飞书聊天命令

| 命令 | 说明 |
| --- | --- |
| `/new`、`/reset` | 清空当前 chat / topic 的 Codex thread，下一条消息新建会话。 |
| `/new chat [name]` | 新建群并拉你进去，继承当前 cwd。 |
| `/cd <path>` | 切换当前 chat / topic 的工作目录；会重置 session。支持 `~/xxx`。 |
| `/ws list` | 查看命名工作空间。 |
| `/ws save <name>` | 把当前 cwd 保存为命名工作空间。 |
| `/ws use <name>` | 切换到命名工作空间；会重置 session。 |
| `/ws remove <name>` | 删除命名工作空间。 |
| `/account` | 查看当前应用信息。 |
| `/account change` | 更换 appId / secret 并重连。 |
| `/config` | 调整偏好，例如回复方式、工具调用显示、并发数、idle timeout。 |
| `/status` | 查看当前 scope、cwd、session、agent。 |
| `/stop` | 终止当前正在跑的 Codex 任务。 |
| `/timeout [N\|off\|default]` | 设置当前 session 的 idle 探活分钟数，或关闭 / 恢复全局默认。 |
| `/ps` | 列出本机所有 bot，并标识当前正在回复的进程。 |
| `/exit <id\|#>` | 关闭指定 bot 进程。 |
| `/reconnect` | 强制重连 WebSocket。 |
| `/doctor [描述]` | 把最近日志和故障描述交给 Codex 自助诊断。 |
| `/help` | 显示帮助卡片。 |

其他普通消息会直接交给 Codex。群聊默认需要 `@bot`；私聊不需要。

## 数据目录

| 路径 | 说明 |
| --- | --- |
| `~/.feishu-codex-bridge/config.json` | 应用凭据引用和偏好配置。 |
| `~/.feishu-codex-bridge/secrets.enc` | 本地加密 secret keystore。 |
| `~/.feishu-codex-bridge/sessions.json` | 每个 chat / topic 的 Codex thread id、cwd 和可选 timeout 覆盖。 |
| `~/.feishu-codex-bridge/workspaces.json` | 命名工作空间映射。 |
| `~/.feishu-codex-bridge/processes.json` | 当前运行的 bridge 进程注册表。 |
| `~/.feishu-codex-bridge/media/` | 下载的图片 / 文件缓存。 |
| `~/.feishu-codex-bridge/logs/` | 结构化运行日志和 daemon stdout / stderr。 |

## Codex 偏好配置

可在 `config.json` 的 `preferences` 中设置：

```json
{
  "preferences": {
    "codexBinary": "codex",
    "codexModel": "gpt-5.1",
    "messageReply": "markdown",
    "showToolCalls": true,
    "maxConcurrentRuns": 10,
    "runIdleTimeoutMinutes": 0,
    "agentStopGraceMs": 5000
  }
}
```

- `codexBinary`：Codex 可执行文件名或绝对路径，默认 `codex`。
- `codexModel`：传给 `codex exec -m` 的模型；留空则由 Codex 自身配置决定。
- `messageReply`：`card`、`markdown` 或 `text`。
- `showToolCalls`：是否在卡片 / Markdown 中展示命令执行过程。

## 和 codex-remote-feishu 的区别

本项目是轻量聊天桥，适合把飞书消息直接交给本机 Codex CLI。需要完整远程接管、VS Code 跟随、daemon/app-server 协议和后台 thread 管理时，请使用 `codex-remote-feishu`。

## 故障排查

- `run` 启动时报找不到 `codex`：先确认 `codex --version` 可用，并执行 `codex login`。
- Codex 没有继续上次对话：发 `/status` 查看 cwd 和 session；cwd 变化会让 bridge 自动新建 session。
- 群聊没响应：确认消息里 `@bot`，或在 `/config` 里调整群聊 mention 策略。
- 卡片长时间不动：可用 `/stop` 终止当前任务，或用 `/timeout 10` 为当前 session 开启 idle 探活。
- 飞书 API 工具不可用：按启动提示安装并绑定 `lark-cli`。
