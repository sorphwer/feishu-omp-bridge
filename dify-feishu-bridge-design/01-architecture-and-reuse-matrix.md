# 01 · 架构与复用矩阵

> 内容：`dify-feishu-bridge` 目标仓库布局；对现仓库每个 `src/**/*.ts` 的 COPY-UNCHANGED / ADAPT / REPLACE / DROP 分类与一句理由；唯一的共享接口改动。
>
> 事实来源：现仓库实现见 [../how-it-works/](../how-it-works/README.md)，逐子系统对应。

> 同一 `AgentAdapter` 缝也支持在本仓库内并存第二个 adapter 并按 config 选择；本系列按用户指定的独立克隆来写，复用矩阵两种方式都适用。

## 1. 目标仓库布局

镜像现仓库，仅把 `src/agent/omp/` 换成 `src/agent/dify/`，并删掉若干 OMP 专属件：

```text
dify-feishu-bridge/
  bin/dify-feishu-bridge.mjs        # import '../dist/cli.js'
  src/
    index.ts                        # COPY
    agent/
      types.ts                      # ADAPT（+user?,+attachments?）
      index.ts                      # ADAPT（导出 DifyAdapter）
      dify/                         # REPLACE（取代 omp/）
        types.ts  sse.ts  files.ts  adapter.ts
    bot/
      channel.ts comments.ts          # ADAPT
      pending-queue.ts process-pool.ts active-runs.ts scope.ts  # COPY
      chat-mode-cache.ts interactive-card.ts quote.ts reaction.ts # COPY
      group.ts keepalive.ts network-config.ts wizard.ts # COPY
      （删 feishu-host.ts / command-tools.ts / guest-lockdown.ts）
    card/
      run-state.ts run-renderer.ts text-renderer.ts tool-render.ts # COPY
      managed.ts dispatcher.ts omp-ui.ts account-cards.ts # COPY
      config-card.ts templates.ts   # ADAPT（数据根路径串 / help 去 /switch）
      （删 switch-card.ts）
    commands/index.ts               # ADAPT
    config/
      schema.ts policy.ts secret-resolver.ts paths.ts  # ADAPT
      store.ts keystore.ts          # COPY
    cli/
      index.ts                      # ADAPT（CLI 名 + 删 migrate 死 import）
      preflight.ts                  # ADAPT
      commands/start.ts service.ts  # ADAPT
      commands/ps.ts secrets.ts     # ADAPT（用法串品牌名）
      （删 commands/migrate.ts）
    daemon/
      service-adapter.ts launchd.ts systemd.ts schtasks.ts # COPY
      paths.ts                      # ADAPT（服务标识重命名）
    relay/
      front.ts route.ts worker.ts   # COPY
      protocol.ts                   # ADAPT（仅 KEY_LABEL）
    session/store.ts workspace/store.ts media/cache.ts runtime/registry.ts # COPY
    core/logger.ts utils/feishu-auth.ts # COPY
```

## 2. 逐文件复用矩阵

> 约定：测试文件随其模块归类。`find src -name '*.ts'` 的每个文件在下表恰好出现一次（含 `*.test.ts`）。

> COPY-UNCHANGED 指**逻辑/结构零改动、可整文件复制**；其中**注释级**品牌串（`feishu-omp-bridge` 字样）在全局重命名时顺带替换，不构成设计决策。若文件含**用户可见**的品牌串/路径（CLI 名、用法提示、卡片里的数据目录路径），则归 ADAPT。数据根集中在 `config/paths.ts`（ADAPT），多数模块经 `paths.*` 间接引用、无需各自改动。

### COPY-UNCHANGED（原样复制）

| 文件 | 理由 |
| --- | --- |
| `src/index.ts` | 公开导出 `renderCard`/`renderText`/`reduce` 等，后端无关。 |
| `card/run-state.ts`（+`run-state.test.ts`） | `reduce()` 只认 `AgentEvent`，后端无关。见 [../how-it-works/05](../how-it-works/05-streaming-and-cards.md)。 |
| `card/run-renderer.ts` | CardKit 渲染只读 `RunState`。 |
| `card/text-renderer.ts` | 同上。 |
| `card/tool-render.ts` | 工具头/体渲染只读 `ToolEntry`。 |
| `card/managed.ts` | 托管卡片生命周期，飞书 CardKit，后端无关。 |
| `card/dispatcher.ts` | 卡片回调路由（access→`__omp_ui`→`__codex_cb`→`cmd`），后端无关；`__omp_ui` 分支在 Dify 下空转但无害。 |
| `card/omp-ui.ts`（+`omp-ui.test.ts`） | OMP 交互卡片构建；Dify 不发 `ui_request` 故**空转/休眠**，保留零成本。 |
| `card/account-cards.ts` | `/account` 凭据卡，飞书侧，后端无关。 |
| `bot/pending-queue.ts` | 去抖队列，后端无关。见 [../how-it-works/04](../how-it-works/04-message-pipeline.md)。 |
| `bot/process-pool.ts` | 并发上限，后端无关。 |
| `bot/active-runs.ts`（+`active-runs.test.ts`） | run 生命周期，只认 `AgentRun`；`submitPrompt?`/`respondToUi?` 可选缺失安全降级。 |
| `bot/scope.ts` | scope 计算，后端无关。 |
| `bot/chat-mode-cache.ts` | chat 模式缓存，飞书侧。 |
| `bot/interactive-card.ts` | 交互卡片展开，飞书侧。 |
| `bot/quote.ts` | 引用消息抓取/规范化，飞书侧。 |
| `bot/reaction.ts` | IM/评论 reaction，飞书侧。 |
| `bot/group.ts` | 建群（`/new chat`），飞书侧。 |
| `bot/keepalive.ts` | WS keepalive，飞书侧。 |
| `bot/network-config.ts` | HTTP/代理，后端无关。 |
| `bot/wizard.ts` | 扫码注册向导，飞书侧。 |
| `utils/feishu-auth.ts` | 凭据校验，飞书侧。 |
| `session/store.ts` | session 持久化；`SessionEntry.sessionId` 改装 Dify `conversation_id`，结构不变。见 [04](./04-config-session-and-guest.md)。 |
| `workspace/store.ts` | 工作空间，后端无关。 |
| `media/cache.ts` | 媒体下载缓存，飞书侧；Dify 下还要把 `LocalAttachment` 上传（见 `files.ts`），但缓存本身不变。 |
| `runtime/registry.ts` | 进程注册表，后端无关。 |
| `config/store.ts`（+`store.test.ts`） | 原子写 + JSON/YAML 读写 + 加密账户配置 + secrets-getter 包装，后端无关。 |
| `config/keystore.ts` | AES keystore，后端无关。`dify.apiKey` 也存这里。 |
| `core/logger.ts` | 日志器，后端无关。 |
| `daemon/service-adapter.ts` | 服务适配器接口，后端无关。 |
| `daemon/launchd.ts` / `daemon/systemd.ts` / `daemon/schtasks.ts` | 三平台守护实现；服务名来自 `daemon/paths.ts`（ADAPT），实现逻辑不变。 |
| `relay/front.ts` / `relay/route.ts`（+`route.test.ts`） / `relay/worker.ts`（+`transport.test.ts` 集成测试） | 中继传输，飞书侧，后端无关。 |

### ADAPT（改造）

| 文件 | 改动 |
| --- | --- |
| `agent/types.ts` | 给 `AgentRunOptions` 加 `user?`、`attachments?`（见 §3）。其余契约不变。 |
| `agent/index.ts` | 导出 `DifyAdapter` 替代 `OmpAdapter`，删 model-catalog 导出。 |
| `cli/commands/start.ts` | 构造 `DifyAdapter`（及访客 adapter）；删模型目录探测 + “未找到 omp CLI” 文案；其余（stores/GC/registry/channel/controls/signals）不变。见 [05](./05-channel-and-commands-adaptation.md)。 |
| `bot/channel.ts` | `runAgentBatch` 传 `user`+`attachments`；访客路径改为选 guest adapter；删 `feishu-host`/host-uri 接线；`buildPrompt` 去本地路径附录。`processAgentStream` 不变。见 [05](./05-channel-and-commands-adaptation.md)。 |
| `config/schema.ts`（+`schema.test.ts`） | 删 `omp*`/`codex*`；加 `dify` 块 + 访问器；`policy`/`access` 接口保留（`PolicyConfig`/`ProfileConfig`/`PolicyRule`/`normalizeCommandTools` 仍在此）。见 [04](./04-config-session-and-guest.md)。 |
| `config/secret-resolver.ts`（+`secret-resolver.test.ts`） | 从“解析 `accounts.app.secret`”泛化为“解析任意 `SecretInput`”（`resolveSecret(cfg, input, label)`），使 `dify.apiKey` 复用同一 keystore 管线。 |
| `config/policy.ts`（+`policy.test.ts`） | principals×rules×run-target、`relayRunTarget`、`synthesizeLegacyPolicy` 后端无关、整体复用；仅「profile→运行」落地改为**选 Dify 应用**（`ResolvedProfile.restricted`/`name`/`systemPrompt` → operator/guest/locked app），`builtinTools`/`commandTools`/`discovery`/`memory` 等 OMP 字段在 Dify 下不消费。见 [04](./04-config-session-and-guest.md)。 |
| `bot/comments.ts` | 评论里也按 `resolveBatchProfile` 选 profile；Dify 下改为按 profile 选应用 adapter（删 `buildProfileRunArgs`/`buildCommandTools` 引用），抓取/回复逻辑不变。见 [04](./04-config-session-and-guest.md)。 |
| `config/paths.ts` | 数据根改 `~/.dify-feishu-bridge/`。 |
| `daemon/paths.ts` | 服务标识改 `dify-feishu-bridge.bot` / `ai.dify-feishu-bridge.bot` / `DifyFeishuBridge.Bot` / `dify-feishu-bridge.bot.service`。 |
| `cli/preflight.ts` | 保留 lark-cli 自动安装/绑定；删 OMP 检查；加可选 Dify `GET /parameters` 探测。 |
| `cli/commands/service.ts` | 显示名改 “Dify”。 |
| `commands/index.ts` | 移除或改造 `/switch`；`/status` agent 行显示 `Dify` + app 标签；其余命令不变。见 [05](./05-channel-and-commands-adaptation.md)。 |
| `card/templates.ts` | 帮助文案删 `/switch`（若移除）；措辞调整。 |
| `relay/protocol.ts`（+`protocol.test.ts`） | 仅 `KEY_LABEL`（`feishu-omp-bridge/relay/v1` → `dify-feishu-bridge/relay/v1`）；`protocol.test.ts` 里若有 `KEY_LABEL`/品牌 fixture 一并更新，其余不变。 |
| `card/config-card.ts` | 用户可见串改 `~/.dify-feishu-bridge/...` 路径，并从 admin 命令帮助里去掉 `/switch`；表单字段逻辑不变。 |
| `cli/index.ts` | commander `.name`/描述/`secrets` 描述改品牌名；删去对 `runMigrate` 的死 import（随 migrate.ts DROP）。 |
| `cli/commands/ps.ts` | 用法提示串 `feishu-omp-bridge` → `dify-feishu-bridge`；逻辑不变。 |
| `cli/commands/secrets.ts` | 用法提示串 + `secrets.enc` 路径文案改品牌名；exec-provider 协议逻辑不变。 |

### REPLACE（新建于 `src/agent/dify/`，取代 `src/agent/omp/*`）

| 文件 | 职责 |
| --- | --- |
| `agent/dify/adapter.ts` | `DifyAdapter implements AgentAdapter`。见 [03](./03-dify-adapter.md)。 |
| `agent/dify/sse.ts` | SSE 行解析 + Dify 事件→`AgentEvent` 翻译（对应 OMP 的 `createEventStream`/`translateOmpFrame`）。 |
| `agent/dify/files.ts` | 把本地附件上传到 Dify（`POST /files/upload`）。 |
| `agent/dify/types.ts` | Dify SSE 事件 TS 类型（对应 OMP 的 `rpc.ts` 帧类型）。 |

### DROP（删除）

| 文件 | 理由 |
| --- | --- |
| `agent/omp/adapter.ts`（+`adapter.test.ts`） | 被 `agent/dify/adapter.ts` 取代。 |
| `agent/omp/rpc.ts`（+`rpc.test.ts`） | 被 `agent/dify/sse.ts` 取代。 |
| `agent/omp/args.ts`（+`args.test.ts`） | OMP CLI 参数构建，Dify 无 CLI。 |
| `agent/omp/model-catalog.ts`（+`model-catalog.test.ts`） | OMP 模型目录；Dify 模型在 app 内固定。 |
| `bot/feishu-host.ts`（+`feishu-host.test.ts`） | Dify 无 host-callback 通道（飞书上下文改走 prompt 注入）。见 [03](./03-dify-adapter.md) 行为保真。 |
| `bot/command-tools.ts`（+`command-tools.test.ts`） | OMP CLI 工具封锁的一部分；访客限制改为应用路由。见 [04](./04-config-session-and-guest.md)。 |
| `bot/guest-lockdown.ts`（+`guest-lockdown.test.ts`） | 同上——`--tools`/`--config`/hook 对 Dify 不适用。 |
| `card/switch-card.ts`（+`switch-card.test.ts`） | 无模型选择器（除非选“应用选择器”，见 [04](./04-config-session-and-guest.md)）。 |
| `cli/commands/migrate.ts` | 遗留 `feishu-codex-bridge` 迁移，与全新克隆无关。 |

> 仓库外但相关：`scripts/test-guest.ts`（OMP 访客越权回归脚本）应重写为针对“访客应用路由”的回归，或删除——它不在 `src/` 矩阵范围内。

## 3. 唯一的共享接口改动

给 `agent/types.ts` 的 `AgentRunOptions` 增两个**可选**字段：

```ts
/** End-user identity for backends that need it (Dify `user`). */
user?: string;
/** All resolved local attachments (not just images) for backends that upload. */
attachments?: { path: string; kind: 'image' | 'file' | 'audio' | 'video'; name?: string }[];
```

并在 `bot/channel.ts` 的 `runAgentBatch` 里设置：`user: firstMsg.senderId`、`attachments` 来自 `media.resolve(...)`（即现有 `LocalAttachment[]`，见 [../how-it-works/07](../how-it-works/07-sessions-workspaces-media.md)）。

OMP 风格的 adapter 二者皆忽略（向后兼容）；Dify adapter 消费它们（`user` 进 `POST /chat-messages` 的 `user` 字段；`attachments` 经 `files.ts` 上传成 `files[]`）。这是整个迁移**唯一**的共享契约改动——其余全部在 `agent/dify/*` 与 ADAPT 文件内。

> `AgentRunOptions` 现有的 `imagePaths?`（OMP 的原生图片入参）在 Dify 下不再使用——图片走 `attachments`（`kind:'image'`）经 `files.ts` 上传。保留字段以维持类型兼容，Dify adapter 忽略它。
