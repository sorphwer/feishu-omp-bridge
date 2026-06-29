# 06 · 迁移与验证

> 内容：从现仓库立起 `dify-feishu-bridge` 克隆的逐步操作；克隆落地后的验证计划（供文档陈述，不在此刻执行）。
>
> 前序：[01 复用矩阵](./01-architecture-and-reuse-matrix.md)、[03 适配器](./03-dify-adapter.md)、[04 配置/会话/访客](./04-config-session-and-guest.md)、[05 通道与命令适配](./05-channel-and-commands-adaptation.md)。

> 同一 `AgentAdapter` 缝也支持在本仓库内并存第二个 adapter 并按 config 选择；本系列按用户指定的独立克隆来写，复用矩阵两种方式都适用。

## 1. 起克隆的步骤

1. **复制仓库**，重命名 `package.json` 的 `name`/`bin` → `dify-feishu-bridge`、`bin/dify-feishu-bridge.mjs`、`daemon/paths.ts` 服务标识、`config/paths.ts` 数据根 `~/.dify-feishu-bridge/`、`relay/protocol.ts` 的 `KEY_LABEL`、`cli/index.ts` 的 `.name`/描述、`channel.ts` 的 `source`、`ps.ts`/`secrets.ts` 用法串（见 [05](./05-channel-and-commands-adaptation.md) §5）。
2. **删 DROP 文件**：`agent/omp/*`、`bot/feishu-host.ts`、`bot/command-tools.ts`、`bot/guest-lockdown.ts`、`card/switch-card.ts`、`cli/commands/migrate.ts`（及各自 `*.test.ts`）。同步删 `cli/index.ts` 里对 `runMigrate` 的死 import、`commands/index.ts`/`templates.ts`/`config-card.ts` 里对 `/switch`/`switch-card` 的引用、`channel.ts`/`start.ts` 里对 `feishu-host`/`command-tools`/`guest-lockdown`/`model-catalog` 的 import。重写或删除 `scripts/test-guest.ts`。
3. **加 `src/agent/dify/{types,sse,files,adapter}.ts`**（见 [03](./03-dify-adapter.md)）。
4. **应用 `AgentRunOptions` 增量**（`user?`/`attachments?`，见 [01](./01-architecture-and-reuse-matrix.md) §3）并改 `agent/index.ts` 导出 `DifyAdapter`。
5. **改 ADAPT 文件**：`start.ts`/`channel.ts`/`schema.ts`/`secret-resolver.ts`/`commands/index.ts`/`preflight.ts`/`service.ts`/`paths.ts`/`daemon/paths.ts`/`templates.ts`/`config-card.ts`/`relay/protocol.ts`（见 [04](./04-config-session-and-guest.md)、[05](./05-channel-and-commands-adaptation.md)）。
6. **更新测试**：删 `agent/omp/*` 测试；加一个 `sse.ts` 翻译单测断言映射表；agent-无关的测试（`run-state.test.ts`、`active-runs.test.ts`、与 `/switch` 无关的 `schema.test.ts` 项）保留。`omp-ui.test.ts` 保留（`omp-ui` 仍在但休眠）。

## 2. 验证计划（克隆落地后执行）

1. **构建/类型/测试**：`pnpm typecheck && pnpm test && pnpm build`。
2. **`sse.ts` 单测**：喂一段抓取的 Dify SSE 实录——含若干 `message`、一个带 `tool`+`observation` 的 `agent_thought`、一个 `message_end`——断言产出的 `AgentEvent[]`：
   - 首块 `conversation_id` → 一个 `system{sessionId}`；
   - `message` → 对应 `text{delta}`；
   - `agent_thought(tool)` → `tool_use{id,name,input}`，`agent_thought(observation)` → `tool_result{id,output,isError:false}`；
   - `message_end` → `usage{...}` 然后 `done{sessionId}`。
   再补 workflow 实录（`workflow_started`/`node_started`/`node_finished`/`workflow_finished`）断言 `ui_status` + `tool_use`/`tool_result` + 结束。
3. **手动端到端**（真实 Dify app key）：
   - 私聊 bot，确认流式卡片显示文本 + 一个 tool/node 面板 + 最终 usage footer；
   - 发第二条消息，确认 `conversation_id` 续聊（`sessions.json` 记到 `conversation_id`）；
   - run 中途发 `/stop`，确认 Dify stop 端点触发（`POST /chat-messages/{task_id}/stop`）并 abort fetch；
   - 群里 @bot（或陌生人私聊），确认走 guest adapter（`dify.guestApiKey`）；
   - 带图片/文件消息，确认 `files.ts` 上传后 Dify 能引用。

## 3. 验证映射表（设计自检）

| 关注点 | 现仓库依据 | 克隆是否保持 |
| --- | --- | --- |
| session 仅在 `system` 持久化 | [../how-it-works/04](../how-it-works/04-message-pipeline.md) §流处理、[../how-it-works/07](../how-it-works/07-sessions-workspaces-media.md) | adapter 必 emit `system{sessionId}`（[03](./03-dify-adapter.md) §2）✅ |
| `submitPrompt` 缺失 → 排下一轮 | [../how-it-works/04](../how-it-works/04-message-pipeline.md) §3 | adapter 省略 `submitPrompt`（[03](./03-dify-adapter.md) §3/§5）✅ |
| `respondToUi` 缺失安全 | [../how-it-works/02](../how-it-works/02-agent-adapter-and-omp.md) §1.5 | adapter 省略，且不发 `ui_request`（[03](./03-dify-adapter.md) §5）✅ |
| 飞书上下文进 app | [../how-it-works/04](../how-it-works/04-message-pipeline.md) §8 buildPrompt | 保留 `<bridge_context>` 等注入（[05](./05-channel-and-commands-adaptation.md) §1.4）✅ |
| 访客隔离 | [../how-it-works/09](../how-it-works/09-access-and-guest-sandbox.md) | 改为 guest 应用路由（[04](./04-config-session-and-guest.md) §4）✅ |
| 复用矩阵完整 | `find src -name '*.ts'` | 每文件恰好分类一次（[01](./01-architecture-and-reuse-matrix.md) §2）✅ |
