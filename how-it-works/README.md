# how-it-works —— feishu-omp-bridge 实现详解

> **源码基线**：本系列描述的源代码状态为 commit `78460f65139e587adddbf340f35cb44ff25438a0`（短 `78460f6`）——这是文档对应的**源码** commit（文档本身随后单独提交，不改动代码）。
>
> 该 commit 引入**统一 policy 模型**（`src/config/policy.ts`：principals × profiles × rules、`resolvePolicy` / `resolveBatchProfile` / `relayRunTarget` / `synthesizeLegacyPolicy`），旧 `access` / `guestPolicy` / `relay.route` 作为 legacy 字段被合成。[04 消息管线](./04-message-pipeline.md)、[08 配置与密钥](./08-config-and-secrets.md)、[09 访问控制与统一策略](./09-access-and-guest-sandbox.md) 及 `../dify-feishu-bridge-design/` 复用矩阵均已对齐。
>
> 维护规则：每次更新 how-it-works 前，先把本源码基线 hash 刷新到对应 commit（代码处于未提交状态时标 dirty）。

> 覆盖范围：本目录是 `feishu-omp-bridge` 当前实现的“事无巨细”说明，逐子系统、逐文件、逐导出符号、逐数据流地解释 bot 如何把飞书/Lark 消息接到本地 `omp --mode rpc`。读完任意一篇 + 其引用的源码，应当能不靠猜测重写该子系统。
>
> 源文件：本篇为索引，引用 `README.md`、`README.zh.md`、`src/**`。

## 项目定位

`feishu-omp-bridge` 不是重新实现一个飞书机器人框架，而是把已有的 Feishu/Lark 桥接层（`@larksuiteoapi/node-sdk` 的 `LarkChannel`）和 Oh My Pi 的 RPC Agent 能力接起来：它把私聊、普通群 `@bot`、话题群 topic、云文档评论 `@bot` 中的消息转给 `omp --mode rpc`，再把 OMP 的文本、thinking、工具调用、工具增量、原生 UI 交互、token usage 和结果流式回写到飞书交互卡片。它适合在飞书里直接驱动本地 OMP 读写项目、跑命令、分析日志、改代码，并让团队共享一个可恢复的 OMP 会话。（引自 `README.md` 项目定位/核心能力两节。）

## 分层架构

```text
       Feishu / Lark 服务端
            │  WebSocket 长连接 / OpenAPI REST
            ▼
  @larksuiteoapi/node-sdk  ──  LarkChannel
            │  NormalizedMessage / CardActionEvent / CommentEvent
            ▼
  src/bot/channel.ts  ── createBridgeRuntime（intake → debounce → run）
            │            ├─ 访问控制 / @提及门控 / 命令分发
            │            ├─ PendingQueue（去抖）+ ProcessPool（并发上限）
            │            └─ runAgentBatch → processAgentStream
            ▼
  src/agent/types.ts  ──  AgentAdapter（唯一的可替换“缝”）
            │  AgentRun.events: AsyncIterable<AgentEvent>
            ▼
  src/agent/omp/OmpAdapter  ──  spawn omp --mode rpc
            │  JSONL over stdio（ready → set_host_tools → get_state → prompt …）
            ▼
       omp --mode rpc --session-dir ~/.feishu-omp-bridge/omp-sessions
```

呈现侧（卡片/文本）只消费规范化后的 `AgentEvent` 联合类型，对“后端是谁”完全无感。换一个后端（例如 Dify）= 只写一个新的 `AgentAdapter`，下游全部复用——这正是 `dify-feishu-bridge-design/` 那套设计文档的立足点。

## 文档清单与建议阅读顺序

| # | 文档 | 一句话 |
| --- | --- | --- |
| — | [README.md](./README.md)（本篇） | 索引、架构图、术语表 |
| 01 | [总览与架构](./01-overview-and-architecture.md) | 四层结构、`AgentAdapter` 缝、启动序列、数据目录 |
| 02 | [Agent 适配器与 OMP](./02-agent-adapter-and-omp.md) | `AgentEvent`/`AgentRun`/`AgentAdapter` 类型参考 + `OmpAdapter` RPC 实现 |
| 03 | [飞书传输层](./03-feishu-transport.md) | `LarkChannel`、事件注册、keepalive、代理、引用、交互卡片展开、relay 中继 |
| 04 | [消息管线](./04-message-pipeline.md) | intake → 去抖 → batch → run → 流式 的端到端主线（脊柱文档） |
| 05 | [流式与卡片](./05-streaming-and-cards.md) | `reduce()` 状态机、CardKit 2.0 渲染、托管卡片、卡片回调分发 |
| 06 | [飞书 host 工具面](./06-feishu-host-surface.md) | `feishu_*` host tools + 只读 `feishu://` scheme |
| 07 | [会话 / 工作空间 / 媒体](./07-sessions-workspaces-media.md) | `sessions.json`、`workspaces.json`、媒体缓存 |
| 08 | [配置与密钥](./08-config-and-secrets.md) | `AppConfig` 全字段、secret 解析五段管线、AES keystore |
| 09 | [访问控制与访客沙箱](./09-access-and-guest-sandbox.md) | allowlist / admin、guestPolicy 三层封锁、command tools |
| 10 | [聊天命令](./10-commands.md) | 命令注册表、admin 门控、逐命令行为 + 卡片 |
| 11 | [守护进程与 CLI 运行时](./11-daemon-cli-runtime.md) | commander CLI、launchd/systemd/schtasks、进程注册表、日志 |

建议顺序：先读 01 建立全局观，再读 02（理解“缝”的契约），然后读 04（端到端主线），04 会反复引用 03/05/06/07；之后按需读 08/09/10/11。

## 术语表

- **scope（作用域）**：会话隔离键。p2p / 普通群为 `chatId`；话题群为 `${chatId}:${threadId}`。session、cwd、pending queue、active run 全部以 scope 为键。见 `src/bot/scope.ts`、`src/bot/channel.ts`。
- **run（一次运行）**：一个 batch prompt 触发的一次 agent 执行，对应一个 `AgentRun`（OMP 下即一个 `omp --mode rpc` 子进程）。
- **batch（批）**：去抖窗口内攒下的一组 `NormalizedMessage`，合并成一个 prompt。见 `PendingQueue`。
- **managed card（托管卡片）**：用 CardKit 2.0 `cardkit.v1.card.create` 创建、可按 `card_id` + 递增 `sequence` 反复 `update` 的卡片（OMP UI 卡片、`/account` 表单等用它）。见 `src/card/managed.ts`。流式回复卡片走 SDK 的 `channel.stream`，是另一条路径。
- **host tool（宿主工具）**：bridge 在进程内实现、注册给 OMP 的工具（`feishu_*`、访客 command tools），OMP 通过 RPC `host_tool_call` 回调本地执行，**不经 shell**。见 `src/bot/feishu-host.ts`、`src/bot/command-tools.ts`、`src/agent/types.ts` 的 `AgentHostTool`。
- **guest sandbox（访客沙箱）**：对非信任发送者用三层手段（`--tools` 去内置、`--config` overlay 关发现源/记忆、fail-closed 的 `tool_call` hook）把 OMP 锁到白名单工具。见 `src/bot/guest-lockdown.ts`、`src/config/schema.ts` 的 `GuestToolPolicy`。
- **front / worker（中继角色）**：可选的双进程拓扑——`front` 持有唯一的飞书长连接并把可信发送者的事件转发给 `worker`（如你的笔记本）执行 agent；`worker` 自己回写飞书。见 `src/relay/*`、`src/config/schema.ts` 的 `RelayConfig`。
