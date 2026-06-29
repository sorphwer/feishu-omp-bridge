# feishu-omp-bridge

把飞书 / Lark 消息接入本地 Oh My Pi CLI 的桥接服务。它会把私聊、群聊、话题群、云文档评论中的消息转给 `omp --mode rpc`，再把 OMP 的文本、thinking、工具调用、工具增量、原生 UI 交互和结果流式回写到飞书。

## 项目定位

`feishu-omp-bridge` 不是重新实现一个飞书机器人框架，而是把已有 Feishu/Lark 桥接层和 OMP 的 RPC Agent 能力接起来：

```text
Feishu / Lark
  ↓ WebSocket / OpenAPI
@larksuiteoapi/node-sdk LarkChannel
  ↓ normalized messages / card actions
src/bot/channel.ts
  ↓ AgentAdapter
src/agent/omp/OmpAdapter
  ↓ JSONL stdio RPC
omp --mode rpc --session-dir ~/.feishu-omp-bridge/omp-sessions
```

它适合以下场景：

- 在飞书里直接让本地 OMP 读写项目、运行命令、分析日志、修代码。
- 让团队用飞书群 / 话题群共享一个可恢复的 OMP 会话。
- 让 OMP 原生 `confirm` / `select` / `input` / `editor` UI 在飞书交互卡片中完成。
- 把飞书上下文以 OMP host tools / host URI 的形式暴露给 Agent，而不是让 Agent 绕到 shell 里调用 `lark-cli`。

## 核心能力

### 消息与会话

- 支持飞书 / Lark 私聊、普通群聊 `@bot`、话题群 topic、云文档评论 `@bot`。
- 每个 chat / topic 独立保存 OMP session id，并通过 `omp --mode rpc --resume <session_id>` 续聊。
- 话题群按 `chatId:threadId` 隔离 session、cwd、pending queue 和 active run。
- 支持图片输入：飞书图片会下载到本地缓存，再转成 OMP RPC image payload。
- 支持文件下载缓存，供 OMP 后续按本地路径读取。
- 支持消息 debounce：短时间连续消息会合并成一个 batch prompt。

### OMP RPC 流式输出

- 流式展示 OMP 文本输出。
- 展示 thinking / reasoning 片段。
- 展示工具调用开始、增量更新和最终结果。
- 展示 token usage（当 OMP RPC 返回 usage 时）。
- 支持中断：`/stop` 会向 OMP 发送 `abort`，随后按 grace period 终止进程。

### OMP 原生 UI → 飞书交互卡片

OMP RPC 的 extension UI request 会被映射为飞书卡片，并把用户响应写回同一个 live RPC run：

| OMP UI method | 飞书表现 | 写回 OMP |
| --- | --- | --- |
| `confirm` | 确认 / 否 / 取消按钮 | `extension_ui_response` |
| `select` | 下拉选择 + 提交 / 取消 | `extension_ui_response` |
| `input` | 单行输入 + 提交 / 取消 | `extension_ui_response` |
| `editor` | 多行输入 + 提交 / 取消 | `extension_ui_response` |

非阻塞 UI 事件会渲染进运行卡片或文本输出：

- `notify`
- `setStatus`
- `setWidget`
- `setTitle`
- `set_editor_text`
- `open_url`

当 OMP 正在等待 UI 响应时，idle watchdog 会暂停；用户提交或取消后再恢复探活，避免误杀等待人工输入的 run。

### Feishu-native OMP host surface

每个 OMP run 启动时都会注册 Feishu host tools：

| Tool | 用途 |
| --- | --- |
| `feishu_current_context` | 返回当前 scope、chat、topic、触发消息、cwd。 |
| `feishu_send_message` | 向当前 chat 或显式 `chatId` 发送 Markdown。 |
| `feishu_reply_message` | 回复触发消息或显式 `messageId`。 |
| `feishu_get_message` | 按 `messageId` 拉取并规范化飞书消息。 |

同时注册只读 `feishu://` host URI scheme：

- `feishu://current/context`
- `feishu://message/<message_id>`

这使 OMP 可以通过结构化 host callback 使用飞书资源，而不是让模型在 shell 里拼 `lark-cli` 命令。桥接层负责权限、当前上下文、消息解析和结果格式化。

### Mid-run follow-up / steer

当某个 chat/topic 已经有 OMP run 正在执行时，同一 scope 的新普通消息不会排队等下一轮，而是直接写入当前 RPC run：

- 普通消息 → OMP `follow_up`
- 以 `!` 开头的消息 → OMP `steer`

例如：

```text
再看一下 tests 目录
```

会进入当前 run 的 follow-up；

```text
!先不要改代码，只分析原因
```

会进入当前 run 的 steer。

## 前置条件

- Node.js `>= 20`
- pnpm
- 已安装并配置 Oh My Pi CLI，并确认：

```bash
omp --version
omp --mode rpc
```

- 一个飞书 / Lark PersonalAgent 应用。
- 如果需要让 OMP 继续使用传统飞书 CLI 工具，可按启动提示安装并绑定 `lark-cli`；host tools 不依赖 OMP 自己 shell 出 `lark-cli`。

## 快速开始

```bash
git clone https://github.com/Gyarados4157/feishu-omp-bridge.git
cd feishu-omp-bridge
pnpm install
pnpm build
node bin/feishu-omp-bridge.mjs run
```

不带子命令运行时，等价于 `run`：

```bash
node bin/feishu-omp-bridge.mjs
```

如果之后发布为 npm 包，CLI binary 名称是：

```bash
feishu-omp-bridge
```

## 首次启动向导

首次启动会检查配置并交互式引导：

1. 选择租户品牌：飞书或 Lark。
2. 输入 PersonalAgent App ID / App Secret。
3. 可选安装并绑定 `lark-cli`。
4. 写入 `~/.feishu-omp-bridge/config.json`。
5. App Secret 迁移到本地加密 keystore，避免明文留在配置文件中。

常用启动命令：

```bash
node bin/feishu-omp-bridge.mjs run
```

跳过 `lark-cli` 预检查：

```bash
node bin/feishu-omp-bridge.mjs run --skip-check-lark-cli
```

使用指定配置文件：

```bash
node bin/feishu-omp-bridge.mjs run -c /path/to/config.json
```

## 后台运行

```bash
node bin/feishu-omp-bridge.mjs start      # 注册（如需）并启动 OS 管理的后台 daemon
node bin/feishu-omp-bridge.mjs status     # 查看 daemon 状态、pid、日志路径
node bin/feishu-omp-bridge.mjs restart    # 重启 daemon
node bin/feishu-omp-bridge.mjs stop       # 停止 daemon，但保留注册文件
node bin/feishu-omp-bridge.mjs unregister # 删除 daemon 注册文件
```

后台实现：

| 平台 | 后台机制 | 标识 |
| --- | --- | --- |
| macOS | launchd user agent | `ai.feishu-omp-bridge.bot` |
| Linux | systemd user unit | `feishu-omp-bridge.bot.service` |
| Windows | Task Scheduler | `FeishuOmpBridge.Bot` |

进程级命令：

```bash
node bin/feishu-omp-bridge.mjs ps
node bin/feishu-omp-bridge.mjs kill <id|#>
```

## 配置文件

默认配置路径：

```text
~/.feishu-omp-bridge/config.json
```

典型结构：

```json
{
  "accounts": {
    "app": {
      "id": "cli_xxxxxxxxxxxxxxxx",
      "tenant": "feishu",
      "secret": {
        "source": "exec",
        "provider": "feishu-omp-bridge",
        "id": "app-cli_xxxxxxxxxxxxxxxx"
      }
    }
  },
  "secrets": {
    "providers": {
      "feishu-omp-bridge": {
        "source": "exec",
        "command": "~/.feishu-omp-bridge/secrets-getter"
      }
    }
  },
  "preferences": {
    "ompBinary": "omp",
    "ompSessionDir": "~/.feishu-omp-bridge/omp-sessions",
    "messageReply": "card",
    "showToolCalls": true,
    "maxConcurrentRuns": 10,
    "runIdleTimeoutMinutes": 0,
    "requireMentionInGroup": true
  }
}
```

### `preferences` 字段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `ompBinary` | `omp` | OMP 可执行文件名或绝对路径。 |
| `ompModel` | 未设置 | 传给 `omp --model`；留空由 OMP 自身配置决定。 |
| `ompThinking` | 未设置 | 传给 `omp --thinking`。 |
| `ompSessionDir` | `~/.feishu-omp-bridge/omp-sessions` | bridge 专用 OMP session 目录。 |
| `ompTools` | 未设置 | 传给 `omp --tools` 的逗号分隔工具白名单；留空使用 OMP 默认工具集。 |
| `messageReply` | `markdown` | `card`、`markdown` 或 `text`。推荐使用 `card` 以获得完整交互。 |
| `showToolCalls` | `true` | 是否展示工具调用过程。 |
| `maxConcurrentRuns` | `10` | 全局并发 OMP run 上限，范围按代码限制到最多 50。 |
| `runIdleTimeoutMinutes` | 关闭 | OMP 长时间无输出时的 idle kill 分钟数；`0` 或未设置表示关闭。 |
| `requireMentionInGroup` | `true` | 群聊是否必须 `@bot` 才响应；私聊不受影响。 |
| `agentStopGraceMs` | `5000` | OMP 进程收到停止信号后等待 SIGKILL 的毫秒数，限制在 100-30000。 |

### 访问控制

可在 `preferences.access` 中限制用户、群和管理员：

```json
{
  "preferences": {
    "access": {
      "allowedUsers": ["ou_xxx"],
      "allowedChats": ["oc_xxx"],
      "admins": ["ou_xxx"]
    }
  }
}
```

语义：

- `allowedUsers` 空或未设置：允许所有用户。
- `allowedChats` 空或未设置：允许所有 chat。
- `admins` 空或未设置：所有允许用户都可执行管理员命令。
- 管理员命令包括：`/account`、`/config`、`/switch`、`/exit`、`/reconnect`、`/doctor`、`/cd`、`/ws`。

### 访客工具沙箱（`preferences.guestPolicy`，旧字段）

> 旧字段，**仍可用**（无 `policy` 时自动合成等价策略）。新部署推荐用统一 [`policy`](#统一策略policy进阶)（按场景/身份选 profile、多 profile、自定义 hook、front/worker），完整配方见 [配置指南 CONFIGURATION.zh.md](./CONFIGURATION.zh.md)。

对**非信任发送者**(例如陌生人私聊 bot)限制 agent 能用的工具,信任用户(你自己)不受任何影响、保留全部工具。

```json
{
  "preferences": {
    "guestPolicy": {
      "unrestrictedUsers": ["ou_xxx"],
      "commandTools": [
        {
          "name": "zendesk_kg",
          "command": "zendesk-kg",
          "allowedSubcommands": ["search", "stats", "health", "rate"],
          "appendArgs": ["-o", "json"],
          "maxOutputBytes": 100000,
          "description": "Query the Zendesk Knowledge Graph (JSON with issue/solution summaries)."
        },
        {
          "name": "zendesk_docs",
          "command": "zendesk",
          "args": ["docs"],
          "allowedSubcommands": ["search"],
          "appendArgs": ["-o", "text"],
          "maxOutputBytes": 100000,
          "description": "Search the Zendesk Help Center (public docs/articles), plain-text output. First arg must be `search`; then `--query '<text>'` (+ optional filters)."
        }
      ],
      "extraToolAllowlist": [],
      "feishuHostTools": false,
      "systemPrompt": "你是面向同事的 Zendesk 助手:zendesk_kg 查/析历史工单、zendesk_docs 搜帮助中心文档(客户信息已脱敏)。"
    }
  }
}
```

语义:

- **未设置 `guestPolicy`**:功能关闭,所有人都用完整工具集(向后兼容)。
- **设置后**:符合沙箱范围(见下)的消息以受限方式运行 OMP——
  - `commandTools` 把指定 CLI 暴露成 host tool。bridge 用 `spawn`(argv 数组、**不走 shell**)拉起,模型只能跑该二进制,无法注入管道/重定向/命令拼接。`args` 固定前缀、`appendArgs` 固定后缀(放在模型参数之后,例如 `["-o","json"]` 强制结构化完整输出——zendesk-kg 默认 table 只有 metadata);`allowedSubcommands` 限定第一个参数;`maxOutputBytes` 防止大 JSON 被截断成非法(默认 30000)。
  - `--tools` 去掉所有内置工具(bash/eval/read/write/edit/...);`--config` overlay 关掉发现源 MCP(如任意代码执行的 `node_repl`);一个 fail-closed 的 `tool_call` hook 硬拦截白名单外的**一切**工具调用。
  - `extraToolAllowlist`:额外允许的内置工具名(如 `read`)。默认空。
  - `feishuHostTools`:是否给访客开放飞书 host tools(主动发/读消息)。默认 `false`。
  - `systemPrompt`:**仅对访客**生效的提示词,会**前置到访客 prompt** 给沙箱 agent 设定角色/用途;信任用户不受影响。空/未设 = 不前置。(不用 `--append-system-prompt`——给 codex 模型追加系统块会偶发卡死无回复。)
- `unrestrictedUsers` 未设置时回退到 `access.admins`。
- 范围:**群/话题里一律沙箱**(连 operator 也是——群是共享空间,bot 始终是受限助手);**私聊**按发送者信任(operator 全权、其他人沙箱)。fail-closed:senderId 缺失按访客处理。要全权请私聊 bot。
- ⚠️ 改 `guestPolicy` 后需**整进程重启** `restart`(`/reconnect` 不会重建 OMP adapter)。
- 生成的沙箱产物在 `~/.feishu-omp-bridge/guest/`(overlay + 白名单 hook,自动维护)。
- 本地回归验证:`pnpm test:guest`(加 `--model` 跑真实模型越权测试)。

### 统一策略（`policy`，进阶）

`access` / `guestPolicy` / `relay.route` 覆盖常见场景。需要**按场景 × 身份**精细映射工具模式时，用顶层 `policy` 块——三条正交命名轴：

- **`principals`**：命名身份组（open_id）。未列入者 = 隐式 `guest`。每个组可带 `run: front|worker`（在哪端跑；`guest` 恒 front）。
- **`profiles`**：命名工具模式。内置 `full`（全开）与 `locked`（零工具）恒存在。`tools: 'all'` = 全开；`tools: [...]` = 受限沙箱（钉死内置工具，关发现源/共享记忆，加 fail-closed hook）。可带 `commandTools` / `feishuHostTools` / `maxToolCalls` / `systemPrompt` / `discovery` / `memory` / `extensions`（你自己的 `.mjs` hook 文件路径，做更复杂的工具/调用次数限制，与自动 hook 叠加）。
- **`rules`**：首条命中（first-match）映射 `{ when: { chat?, principal?, chatId? }, profile }`；`chat` 取 `p2p`/`group`/`topic`（`group` 亦匹配 `topic`）。

```json
{
  "policy": {
    "principals": {
      "owner": { "users": ["ou_me"], "run": "worker" },
      "team": ["ou_a", "ou_b"]
    },
    "profiles": {
      "readonly": { "tools": ["read", "search"] },
      "kb": { "tools": [], "commandTools": [{ "name": "zendesk_kg", "command": "zendesk-kg" }] }
    },
    "rules": [
      { "when": { "chat": "p2p", "principal": "owner" }, "profile": "full" },
      { "when": { "chat": "p2p", "principal": "team" }, "profile": "readonly" },
      { "when": { "chat": "group" }, "profile": "kb" }
    ]
  }
}
```

- **缺省 = 向后兼容**：未设 `policy` 时按旧 `access`/`guestPolicy`/`relay.route` 自动合成等价策略，行为不变。
- **显式 = fail-closed**：设了 `policy` 后，未命中任何 rule 或指向未知 profile 的发送者跑 `locked`（零工具），不回落全集——务必写一条兜底 rule。
- 群批次多发送者时**最严者胜**；策略同时作用于消息、卡片回调与云文档评论。
- 配置文件可用 **JSON 或 YAML**（`config.json` / `config.yaml` / `config.yml`，按此顺序取首个存在者）。
- ⚠️ 改 `policy` 后需**整进程重启** `restart`。
- 📖 完整配方（front/worker 分流、群聊 vs 私聊、自定义 `.mjs` hook 等）见 [**配置指南 CONFIGURATION.zh.md**](./CONFIGURATION.zh.md)。

## 中继 / Relay（多机分流）

一个飞书 app 的事件只能投递给单一入口,无法让飞书自己按发送者把"你"投到本地、"别人"投到服务器。relay 解决这个:一台 **front**(常开服务器)持有唯一的飞书长连接,按发送者把信任用户的事件**中继**给一台 **worker**(如你的笔记本);worker 不连飞书事件流,只跑 OMP 并用同一个 app 凭据**自己回写飞书**。其余人留在 front(走访客沙箱)。

```text
你私聊 ─┐                      ┌─ 信任用户 → 中继 → [worker: 你的笔记本] → 跑 omp、直接回飞书
别人私聊 ┴→ 飞书 ─长连接→ [front] ┤
                                └─ 其他人 → front 本地沙箱
```

- **传输**:worker 反向拨入 front 的 HTTP/SSE 端点(穿 NAT,笔记本无需公网入站)。
- **鉴权**:默认无需额外密钥——两端共用同一个 App Secret,握手用从它派生的 HMAC 签名(secret 本身永不上线)。需要独立轮换/吊销时可设 `relay.secret`(见下)。
- **安全边界 = TLS**:HMAC 握手只认证 worker 身份;事件流的机密性与完整性由 TLS 提供。`endpoint` 用明文 `http://`(非 loopback)时启动会告警——主动中间人可读取/伪造事件,而事件会驱动你本地的全工具 agent,务必用 `https://`(服务器侧 TLS 反代即可)。
- **掉线兜底**:worker 不在线时,front 在本地处理信任用户的消息(降级,不丢消息)。

### front 配置(服务器)

```json
{
  "relay": {
    "role": "front",
    "listen": "127.0.0.1:8787"
  }
}
```

- `listen` 可省略,默认 `127.0.0.1:8787`。建议用 TLS 反代(nginx/caddy)对外暴露;直接暴露也行,HMAC 握手是访问闸门。
- 中继名单沿用现有信任配置:`relay.route.users` 显式指定 → 否则非空的 `guestPolicy.unrestrictedUsers` → 否则非空的 `access.admins`。**全空 = 谁都不中继**(fail-safe:绝不会把陌生人转到你的笔记本)。

### worker 配置(笔记本)

```json
{
  "relay": {
    "role": "worker",
    "endpoint": "https://your-server.example"
  }
}
```

- `endpoint` 是 worker 唯一必填项:front 的对外地址(scheme 由你定,反代后用 `https://`)。
- worker 与 front **共用同一个 app**(同 `accounts.app` + 同 App Secret)。worker **不开飞书长连接**,因此不会触发同 app 的"随机派发"冲突,`ps` 里标记为 `worker`。
- `workerId` 可选,默认机器 hostname(仅用于日志/多 worker 区分)。

### 认证密钥(可选 `relay.secret`)

默认两端都从 App Secret 派生 relay HMAC 密钥,**零配置**。想把"能连 relay"与"能以 bot 身份调飞书 API"解耦(独立轮换/吊销、缩小泄漏影响面)时,在 **front 和 worker 同时**设 `relay.secret`:

```json
{ "relay": { "role": "front", "secret": "${RELAY_SECRET}" } }
```

- 支持与 App Secret 相同的形式:明文 / `${ENV}` 模板 / keystore SecretRef(不落明文)。
- **两端必须一致**(都设成同一个值,或都不设)。不一致 → 握手签名对不上,worker 反复 401、front 日志 `auth-reject reason=bad signature`。
- 想踢掉所有 worker:改 `relay.secret` 重启 front 即可,**飞书凭据不动**。

### 路由与边界

- 路由纯按**发送者/操作者信任**判定:信任用户的消息、卡片点击、文档评论都中继到 worker;非信任者一律留在 front。
- 私聊场景(你私聊 bot)完全正确。已知边界:群里非信任成员点击信任用户那条 worker 渲染卡片的按钮,会落到 front 而非 worker(罕见、非安全问题)。
- `relay` 与 `preferences`、未来的顶层段一样,会在 `/account` 切换和首次密钥迁移时被保留,不会丢失。

## 数据目录

| 路径 | 用途 |
| --- | --- |
| `~/.feishu-omp-bridge/config.json` | App 凭据、secret refs、偏好配置。 |
| `~/.feishu-omp-bridge/secrets.enc` | 本地加密 secret keystore。 |
| `~/.feishu-omp-bridge/.keystore.salt` | keystore salt。 |
| `~/.feishu-omp-bridge/secrets-getter` | exec secret provider wrapper。 |
| `~/.feishu-omp-bridge/sessions.json` | 每个 chat/topic 的 OMP session id、cwd、timeout 覆盖。 |
| `~/.feishu-omp-bridge/omp-sessions/` | bridge 专用 OMP JSONL session 文件。 |
| `~/.feishu-omp-bridge/guest/` | 访客沙箱产物（OMP overlay + 工具白名单 hook，自动生成）。 |
| `~/.feishu-omp-bridge/workspaces.json` | 命名工作空间。 |
| `~/.feishu-omp-bridge/processes.json` | 本机 bridge 进程注册表。 |
| `~/.feishu-omp-bridge/media/` | 下载的图片 / 文件缓存。 |
| `~/.feishu-omp-bridge/logs/` | 结构化日志和 daemon stdout/stderr 日志。 |

## 飞书聊天命令

| 命令 | 作用 |
| --- | --- |
| `/new`、`/reset` | 清空当前 chat/topic 的 OMP session，下一条消息新建会话。 |
| `/new chat [name]` | 创建新群并拉你进去，继承当前 cwd。需要 bot 具备 `im:chat` 权限。 |
| `/cd <path>` | 切换当前 chat/topic 的工作目录；会重置 session。支持 `~/xxx`。 |
| `/ws list` | 查看命名工作空间。 |
| `/ws add <name> <path>` | 保存当前 cwd 为命名工作空间。 |
| `/ws use <name>` | 切换到命名工作空间并重置 session。 |
| `/config` | 打开偏好设置卡片。 |
| `/switch` | 弹卡片切换 OMP 模型：下拉列常用（role）模型，或输入框直接输入任意模型名（OMP 模糊匹配）。当前模型来自 `omp config modelRoles`，✅ 标已认证。写入 preferences.ompModel，立即生效，全局。 |
| `/account` | 更换 bot app 凭据并重连。 |
| `/status` | 查看当前 scope、cwd、session、agent。 |
| `/stop` | 终止当前正在执行的 OMP run。 |
| `/timeout [N|off|default]` | 设置当前 session 的 idle timeout，或关闭 / 恢复全局默认。 |
| `/ps` | 列出本机所有 bridge 进程，并标识当前回复进程。 |
| `/exit <id|#>` | 关闭指定 bridge 进程。 |
| `/reconnect` | 强制重连 WebSocket。 |
| `/doctor [描述]` | 把最近日志和故障描述交给 OMP 自助诊断。 |
| `/help` | 显示帮助卡片。 |

普通消息会直接交给 OMP。群聊默认需要 `@bot`；私聊不需要。

## 飞书卡片回调

bridge 会识别两类卡片回调：

1. bridge 自己的命令卡片，例如 `/config`、`/help`、OMP UI 卡片。
2. Agent 生成的 callback payload。为了兼容旧桥接层，内部 marker 仍保留 `__codex_cb` 字符串，但代码变量已经改为通用 agent callback 命名。

Agent callback 会被转成当前 scope 的 follow-up 消息，使 OMP 在同一个 session 中收到用户点击结果。

## OMP host tools 细节

### `feishu_current_context`

入参：无。

返回示例：

```json
{
  "scope": "oc_xxx:omt_xxx",
  "chatId": "oc_xxx",
  "threadId": "omt_xxx",
  "replyToMessageId": "om_xxx",
  "cwd": "/Users/me/project"
}
```

### `feishu_send_message`

入参：

```json
{
  "content": "Markdown 内容",
  "chatId": "可选，默认当前 chat"
}
```

行为：向目标 chat 发送 Markdown。若目标是当前 topic 所在 chat，会带上 thread reply 选项。

### `feishu_reply_message`

入参：

```json
{
  "content": "Markdown 回复内容",
  "messageId": "可选，默认触发本轮的消息"
}
```

行为：回复指定消息；在 topic 中会尽量保持 thread reply。

### `feishu_get_message`

入参：

```json
{
  "messageId": "om_xxx"
}
```

行为：读取并规范化指定飞书消息，适合让 OMP 查看引用消息、卡片来源或转发内容。

## `feishu://` URI

OMP 可读取：

```text
feishu://current/context
feishu://message/<message_id>
```

当前 scheme 只读。写操作会返回错误，避免 Agent 绕开 bridge 的消息发送工具和权限边界。

## 安全说明

- 不要提交 `~/.feishu-omp-bridge/config.json`、`secrets.enc`、日志或 session 文件。
- App Secret 默认迁移到本地加密 keystore；`config.json` 只保存 SecretRef。
- 本地 keystore 防止备份、误提交、日志泄漏中的明文暴露；它不是同用户进程级别的强隔离密钥库。
- OMP 可以运行本机工具，等价于把飞书消息授权给本地 Agent 执行。生产使用建议配置：
  - `preferences.access.allowedUsers`
  - `preferences.access.allowedChats`
  - `preferences.access.admins`
  - `ompTools` 工具白名单（全局，对所有人生效）
  - `policy` 统一访问策略（principals/profiles/rules；推荐）或旧 `preferences.guestPolicy` 访客沙箱，见 [配置指南](./CONFIGURATION.zh.md)
  - 固定工作目录 / 命名工作空间
- 群聊默认必须 `@bot` 才响应，避免无意触发。
- `@全员` 不会触发响应。

## 开发

安装依赖：

```bash
pnpm install
```

开发 watch：

```bash
pnpm dev
```

类型检查：

```bash
pnpm typecheck
```

测试：

```bash
pnpm test
```

构建：

```bash
pnpm build
```

查看 CLI：

```bash
node bin/feishu-omp-bridge.mjs --help
```

## 验证状态

本仓库当前代码层验证覆盖：

- OMP RPC adapter 参数、事件翻译、session/run 生命周期。
- OMP 原生 UI request/response。
- OMP host tool / host URI callback。
- active run 的 UI response 与 mid-run prompt 路由。
- 配置 schema。
- run-state reducer 与飞书卡片相关逻辑。

常规验证命令：

```bash
pnpm typecheck
pnpm test
pnpm build
```

真实飞书端到端验证需要可用的 PersonalAgent 凭据和实际飞书会话环境。

## 故障排查

| 问题 | 处理 |
| --- | --- |
| 启动时报找不到 `omp` | 确认 `omp --version` 可用，并先运行一次 `omp` 完成模型 / 认证配置。 |
| OMP RPC 启动后无响应 | 单独运行 `omp --mode rpc` 做 smoke test；检查 `~/.feishu-omp-bridge/logs/`。 |
| OMP 没有续上次对话 | 发 `/status` 查看 cwd 和 session；cwd 变化会自动新建 session。 |
| 群聊无响应 | 确认消息里 `@bot`，或在 `/config` / `config.json` 中调整 `requireMentionInGroup`。 |
| 卡片长时间不动 | 用 `/stop` 中断；也可设置 `/timeout 10` 开启当前 session idle 探活。 |
| OMP 等待选择 / 输入 | 回复单独出现的“OMP 交互”卡片；等待期间 idle watchdog 会暂停。 |
| 飞书 API 工具不可用 | 按启动提示安装并绑定 `lark-cli`；或者优先使用已注册的 Feishu host tools。 |
| `/new chat` 失败 | 确认 bot 具备创建群相关权限，代码中该能力依赖 `im:chat`。 |
| 后台 daemon 不工作 | 运行 `node bin/feishu-omp-bridge.mjs status` 查看服务状态和日志路径。 |

## 当前限制

- 当前 Feishu host URI 只支持 `current/context` 和 `message/<message_id>`。
- `feishu://` 只读；发送消息请使用 `feishu_send_message` 或 `feishu_reply_message`。
- 真实飞书端到端能力取决于 PersonalAgent 权限、租户策略和网络环境。
- OMP SDK 深集成尚未启用；当前主路径是更稳定、易调试、进程隔离更清晰的 `omp --mode rpc`。

## License

MIT
