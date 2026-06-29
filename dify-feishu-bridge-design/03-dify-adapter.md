# 03 · Dify 适配器

> 内容：`DifyAdapter`（`agent/dify/adapter.ts`）、`sse.ts` 的 Dify→`AgentEvent` 映射表、`files.ts` 上传、`AgentRun` 方法、以及行为保真说明。
>
> 契约依据：[02 Dify 流式契约](./02-dify-streaming-contract.md)。要复刻的参考实现是 OMP 适配器：见 [../how-it-works/02](../how-it-works/02-agent-adapter-and-omp.md)（`createEventStream`/`translateOmpFrame` 的形状 1:1 对应这里的 `run`/`sse.ts`）。

> 同一 `AgentAdapter` 缝也支持在本仓库内并存第二个 adapter 并按 config 选择；本系列按用户指定的独立克隆来写，复用矩阵两种方式都适用。

## 1. `DifyAdapter`

`implements AgentAdapter`（`agent/types.ts`）：

- `id = 'dify'`、`displayName = 'Dify'`。
- 构造 `{ baseUrl, apiKey（已解析明文）, inputs?: Record<string,string>, deriveUser? }`。
- `isAvailable()`：配置齐全 + 尽力 `GET {base}/parameters` 返回 200（非致命，探测失败仍返回 true，避免启动被网络抖动卡死）。

### `run(opts: AgentRunOptions): AgentRun`

构造请求：

```ts
{
  inputs: { ...this.inputs },
  query: opts.prompt,
  response_mode: 'streaming',
  conversation_id: opts.sessionId ?? '',
  user: opts.user ?? '<fallback>',     // fallback 见 [04] 的 deriveUser
  files: await uploadAll(opts.attachments),
}
```

忽略 `opts.model` / `opts.cwd` / `opts.tools` / `opts.configOverlayPaths` / `opts.extensionPaths` / `opts.hostTools` / `opts.hostUriSchemes` / `opts.stopGraceMs` / `opts.imagePaths`（Dify 无对应概念；图片走 `attachments`→`files`）。

用 `fetch` + `AbortController` 打开流；`events` 是基于 `sse.ts` 的异步生成器。整体形状对应 OMP 的 `createEventStream`（只是 spawn→fetch、JSONL→SSE）。

## 2. Dify → `AgentEvent` 映射表（`sse.ts`，固定）

> 逐字实现下表。每一行对应 [02](./02-dify-streaming-contract.md) 的一个 SSE 事件。

| Dify 事件 | 产出 `AgentEvent` |
| --- | --- |
| 首个带 `conversation_id` 的 chunk | 一次性 `{type:'system', sessionId: conversation_id}`；并暂存 `task_id` 供 `stop()`。 |
| `message` / `agent_message` | `{type:'text', delta: answer}` |
| `agent_thought`（`tool` 非空、首次见到该 `id`） | `{type:'tool_use', id, name: tool, input: tryParseJson(tool_input) ?? tool_input}` |
| `agent_thought`（`observation` 非空） | `{type:'tool_result', id, output: observation, isError:false}` |
| `agent_thought.thought` 文本 | **不产出**（与 `agent_message` 重复） |
| `message_file` | `{type:'text', delta: type==='image' ? \`![file](url)\` : \`[file](url)\`}`（相对 `url` 用 base origin 补全） |
| `message_replace` | `{type:'ui_notice', message:'内容已被审核策略替换', level:'warning'}` 然后 `{type:'text', delta: answer}` |
| `workflow_started` | `{type:'ui_status', status:{key:'workflow', text:'工作流运行中'}}` |
| `node_started` | `{type:'tool_use', id: data.node_id, name: data.title || data.node_type, input: data.inputs ?? {}}` |
| `node_finished` | `{type:'tool_result', id: data.node_id, output: renderOutputs(data.outputs), isError: data.status !== 'succeeded'}` |
| `workflow_finished` | `data.status==='failed'` → `{type:'error', message: data.error ?? 'workflow failed'}`；否则 `{type:'ui_status', status:{key:'workflow'}}`（空 text 即删除该 status 行） |
| `message_end` | `{type:'usage', inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, costUsd: Number(usage.total_price)||undefined}` 然后 `{type:'done', sessionId: conversation_id}` |
| `error` | `{type:'error', message: \`[${code ?? status}] ${message}\`}` |
| `tts_message` / `tts_message_end` / `ping` | 忽略 |
| `iteration_*` / `loop_*` / `parallel_branch_*` | v1 忽略（可选增强：映射成 `ui_status`） |
| 流关闭但无 `message_end` | 见过任何文本 → `{type:'done'}`，否则 `{type:'error', message:'dify stream closed unexpectedly'}` |

要点：

- **必须在首个带 `conversation_id` 的 chunk emit `system{sessionId}`**——`processAgentStream` 仅在 `system` 事件持久化 session（`sessions.set`），`done.sessionId` 不持久化（见 [../how-it-works/04](../how-it-works/04-message-pipeline.md) §流处理、[../how-it-works/07](../how-it-works/07-sessions-workspaces-media.md)）。若只在 `done` 给 sessionId，会话续聊会断。
- `tool_use`/`tool_result` 用同一 `id`（`agent_thought.id` 或 `node_id`）配对，下游 `reduce()` 才能把结果回填到对应工具面板（见 [../how-it-works/05](../how-it-works/05-streaming-and-cards.md)）。
- `node_finished` 的 `isError` 取 `status !== 'succeeded'`，落到卡片红边面板。

## 3. `AgentRun` 方法

- `stop()`：若已知 `task_id` 则 `POST {base}/chat-messages/{task_id}/stop` body `{user}`，再 `abort()` 那个 fetch；`stopGraceMs` 忽略（无子进程信号阶梯）。
- `waitForExit(timeoutMs)`：SSE reader 关闭即 resolve `true`（无子进程）；用一个“已关闭”promise 与超时竞速。
- **省略 `respondToUi` 与 `submitPrompt`**——两者皆可选，缺失是安全降级（见 §4）。

## 4. `files.ts` 上传

`uploadAll(attachments)`：逐个 `POST {base}/files/upload` multipart `{file, user}` → `{id}` → 映射成 `{type: mapKind(kind), transfer_method:'local_file', upload_file_id: id}`。`mapKind`：`image→image`、`audio→audio`、`video→video`、`file→document`。空/未定义 → `[]`。单文件上传失败 → 跳过该文件、不产出事件（记日志）。

附件来源：`channel.ts` 的 `runAgentBatch` 把 `media.resolve(...)` 的 `LocalAttachment[]` 作为 `opts.attachments` 传入（见 [01](./01-architecture-and-reuse-matrix.md) §3、[05](./05-channel-and-commands-adaptation.md)）。

## 5. 行为保真（固定清单）

- **mid-run 跟进 / steer → 排到下一轮**：Dify adapter 不实现 `submitPrompt`，故 `ActiveRuns.submitPrompt` 返回 false（`?? Promise.resolve(false)`），`submitToActiveRun` 返回 false，`intakeMessage` 回落 `pending.push`，消息作为**下一轮**运行（靠 `conversation_id` 续聊）。`!` 前缀失去 steer 语义。见 [../how-it-works/04](../how-it-works/04-message-pipeline.md) §3。
- **无交互 confirm/select/input/editor**：Dify chat API 无此能力 → adapter 不发 `ui_request` → `card/omp-ui.ts` 与 `dispatcher` 的 `__omp_ui` 分支**休眠**（保留无害）；`respondToUi` 从不被调用，省略安全。
- **`message_replace` 渲染为 notice+追加**，非真正替换（飞书卡片无“替换已发文本”原语，故先 `ui_notice` 提示再 `text` 追加）。
- **host tools / `feishu://` 不可用**：Dify 无 host-callback 通道（`feishu-host.ts` 已 DROP）。飞书上下文仍通过 `buildPrompt` 注入的 `<bridge_context>` / `<quoted_message>` / `<interactive_card>` 送进 app（见 [../how-it-works/04](../how-it-works/04-message-pipeline.md) §8、[05](./05-channel-and-commands-adaptation.md)）。
- **`usage` 仅记日志**（同 OMP）——`processAgentStream` 对 `usage` 事件 `continue`，不进 `reduce`。
- **应用模式无感**：chatbot/agent/advanced-chat 的差异完全吸收在 `sse.ts` 翻译里，无 `appType` 配置。

## 6. 与 OMP 适配器的形状对应

| OMP（参考） | Dify（本设计） |
| --- | --- |
| `spawn(omp, args)` | `fetch(POST /chat-messages)` |
| JSONL over stdio | SSE `data:` 行 |
| `createEventStream` 握手（ready→set_host_tools→get_state→prompt） | 单次 POST + SSE 读循环 |
| `translateOmpFrame` switch | `sse.ts` 映射表 |
| `stop()` 写 `abort` 帧 + 信号阶梯 | `POST .../stop` + `AbortController` |
| `get_state` → `system{sessionId}` | 首个 `conversation_id` chunk → `system{sessionId}` |
| host_tool_call/host_uri_request 回调 | 无（DROP） |
| `loadOmpImages`（base64 入参） | `files.ts`（上传得 `upload_file_id`） |
