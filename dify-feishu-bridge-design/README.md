# dify-feishu-bridge —— 设计文档

> 目标：把飞书/Lark 接到 **Dify** 应用，透传 Dify 的 HTTP 流式 API（`POST /chat-messages`，`response_mode: streaming`），替代 `feishu-omp-bridge` 当前的 `omp --mode rpc`。本系列是 `dify-feishu-bridge` 这个**独立克隆仓库**的设计说明（以复用现有代码为主线）。
>
> 本系列所有“当前行为”的事实来源是 `../how-it-works/`（对现仓库的逐子系统实现说明）。设计文档不重复实现细节，只描述**保留 / 改造 / 替换 / 删除**。

> 同一 `AgentAdapter` 缝也支持在本仓库内并存第二个 adapter 并按 config 选择；本系列按用户指定的独立克隆来写，复用矩阵两种方式都适用。

## 一句话洞见：只有一条缝在变

`feishu-omp-bridge` 把整个系统抽象在一条缝后面——`AgentAdapter`（`src/agent/types.ts`）。`AgentAdapter.run(opts)` 返回 `AgentRun`，`AgentRun.events` 是 `AsyncIterable<AgentEvent>`；卡片/流式呈现层只消费规范化的 `AgentEvent` 联合类型。换后端 OMP→Dify = **写一个新 adapter**（`src/agent/dify/`），下游全部复用。见 [../how-it-works/01-overview-and-architecture.md](../how-it-works/01-overview-and-architecture.md) §2、[../how-it-works/02-agent-adapter-and-omp.md](../how-it-works/02-agent-adapter-and-omp.md)。

## 鸟瞰：保留 / 改造 / 替换 / 删除

| 类别 | 范围 | 说明 |
| --- | --- | --- |
| **保留（COPY-UNCHANGED）** | 整个 `card/`（除空转的 `omp-ui` 仍保留）、`bot/` 的传输与管线件（`channel` 除外）、`session/`、`workspace/`、`media/`、`runtime/`、`config/{store,keystore}`、`core/logger`、`daemon/{launchd,systemd,schtasks,service-adapter}`、`cli/index`、`cli/commands/{ps,secrets}`、`relay/{front,route,worker}`、`utils/feishu-auth`、`index.ts` | 飞书侧传输 + 编排 + 呈现 + 运行时，与 agent 后端无关 |
| **改造（ADAPT）** | `agent/types.ts`（加 `user?`/`attachments?`）、`agent/index.ts`、`cli/commands/start.ts`、`bot/channel.ts`、`config/schema.ts`、`config/secret-resolver.ts`、`config/paths.ts`、`daemon/paths.ts`、`cli/preflight.ts`、`cli/commands/service.ts`、`commands/index.ts`、`card/templates.ts`、`card/config-card.ts`、`relay/protocol.ts`（仅 `KEY_LABEL`） | 接线点 + 配置形状 + 标识重命名 |
| **替换（REPLACE）** | `agent/omp/*` → `agent/dify/{types,sse,files,adapter}.ts` | 新 Dify 适配器 |
| **删除（DROP）** | `agent/omp/*`、`bot/feishu-host.ts`、`bot/command-tools.ts`、`bot/guest-lockdown.ts`、`card/switch-card.ts`、`cli/commands/migrate.ts` | OMP 专属 / host-callback / CLI 封锁 / 模型选择器 / 遗留迁移 |

完整逐文件分类与理由见 [01-architecture-and-reuse-matrix.md](./01-architecture-and-reuse-matrix.md)。

## 阅读顺序

| # | 文档 | 内容 |
| --- | --- | --- |
| — | README（本篇） | 目标、洞见、鸟瞰表 |
| 01 | [架构与复用矩阵](./01-architecture-and-reuse-matrix.md) | 目标仓库布局；逐文件 COPY/ADAPT/REPLACE/DROP；唯一的共享接口改动 |
| 02 | [Dify 流式契约](./02-dify-streaming-contract.md) | 端点、请求体、SSE 帧与字段、应用模式 |
| 03 | [Dify 适配器](./03-dify-adapter.md) | `DifyAdapter` + `sse.ts` 翻译表 + `files.ts` + 行为保真 |
| 04 | [配置 / 会话 / 访客](./04-config-session-and-guest.md) | config diff、secret 泛化、session 复用、访客应用路由 |
| 05 | [通道与命令适配](./05-channel-and-commands-adaptation.md) | ADAPT 文件的精确改动 |
| 06 | [迁移与验证](./06-migration-and-verification.md) | 起仓库步骤 + 验证计划 |

建议：先读 01 建立全局映射，再读 02（Dify 契约），03 是核心（适配器 + 映射表），04/05 是配置与改动细节，06 是落地步骤。
