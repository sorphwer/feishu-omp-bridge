# 02 · Dify 流式契约

> 内容：`DifyAdapter` 所用的 Dify HTTP API 权威参考——端点、请求体、SSE 帧与字段、应用模式。本篇是 [03 适配器](./03-dify-adapter.md) 映射表的契约依据。
>
> 来源（Dify 官方文档，核对于本设计撰写时）：
> - `POST /chat-messages`、`ChunkChatCompletionResponse`（`message`/`message_end`/`message_replace`/`tts_*`/`error`/`ping`）：`web/app/components/develop/template/template.en.mdx`、`api/openapi/markdown/service-openapi.md`
> - `agent_message`/`agent_thought`/`message_file`：`template_chat.en.mdx`
> - `workflow_started`/`node_started`/`node_finished`/`workflow_finished`：`template_workflow.en.mdx`、`template_advanced_chat.en.mdx`
> - 停止生成、文件上传：`template_advanced_chat.en.mdx`、`template.en.mdx`

> 同一 `AgentAdapter` 缝也支持在本仓库内并存第二个 adapter 并按 config 选择；本系列按用户指定的独立克隆来写，复用矩阵两种方式都适用。

## 1. 端点

base = `dify.baseUrl`（如 `https://api.dify.ai/v1`，自托管如 `https://dify.example/v1`）。请求头 `Authorization: Bearer <app-api-key>`（app key 形如 `app-xxx`）。

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `{base}/chat-messages` | POST | 发消息，流式。 |
| `{base}/chat-messages/{task_id}/stop` | POST，body `{ user }` | 停止生成（仅流式）。 |
| `{base}/files/upload` | POST，multipart `{ file, user }` → `{ id, ... }` | 上传本地文件供 `local_file` 引用。 |
| `{base}/parameters` | GET | 应用配置探测（`isAvailable` 用）。 |

## 2. `chat-messages` 请求体

```jsonc
{
  "inputs": {},                 // object，默认 {}（app 变量）
  "query": "用户问题",          // string
  "response_mode": "streaming", // 本桥固定 streaming
  "conversation_id": "",        // string，'' = 新会话
  "user": "ou_xxx",             // string，必填，终端用户标识
  "files": [ /* FileInput[] */ ],
  "auto_generate_name": true    // 可选
}
```

`FileInput`：

```jsonc
{
  "type": "image" | "document" | "audio" | "video" | "custom",
  "transfer_method": "remote_url" | "local_file",
  "url": "https://...",         // transfer_method=remote_url 时
  "upload_file_id": "<id>"      // transfer_method=local_file 时（来自 /files/upload）
}
```

## 3. SSE 帧

- 响应 `Content-Type: text/event-stream`。
- 每个 chunk 以 `data: {json}` 行承载，块间以 `\n\n` 分隔。
- 忽略 `event: ping` 行 / `ping` 事件（保活）。
- JSON 内字段 `event` 标明事件类型（如 `"event":"message"`），其余字段随类型而定。

## 4. 全部 SSE 事件与字段

| 事件 `event` | 关键字段 |
| --- | --- |
| `message` / `agent_message` | `task_id`、`message_id`、`conversation_id`、`answer`（文本块）、`created_at` |
| `agent_thought` | `id`、`task_id`、`message_id`、`position`、`thought`、`observation`、`tool`、`tool_input`、`message_files` |
| `message_file` | `id`、`type`、`belongs_to`、`url`、`conversation_id` |
| `message_end` | `task_id`、`message_id`、`conversation_id`、`metadata:{ usage, retriever_resources }` |
| `message_replace` | `task_id`、`message_id`、`answer`（替换内容，如内容审核） |
| `workflow_started` | `task_id`、`workflow_run_id`、`data:{ id, workflow_id, inputs, created_at, ... }` |
| `node_started` | `task_id`、`workflow_run_id`、`data:{ id, node_id, node_type, title, index, inputs, ... }` |
| `node_finished` | `data:{ id, node_id, node_type, title, status, inputs, process_data, outputs, error, elapsed_time, files, ... }`（`status ∈ {succeeded, failed, ...}`） |
| `workflow_finished` | `data:{ id, status, outputs, error, elapsed_time, ... }` |
| `tts_message` / `tts_message_end` | `task_id`、`message_id`、`audio`（base64 mp3 / 末尾空）、`created_at` |
| `error` | `task_id`、`message_id`、`status`（HTTP 码）、`code`、`message` |
| `ping` | 保活，无 payload |

`usage` 字段（`message_end.metadata.usage`）含 `prompt_tokens`、`completion_tokens`、`total_price` 等。

## 5. 应用模式

同一 adapter 无条件处理三类应用：

- **chatbot**：`message` 流。
- **agent**：`agent_message`（文本）+ `agent_thought`（工具/思考/观察）。
- **advanced-chat / workflow**：`message` + `workflow_*`/`node_*` + `message_end`。

适配器对所有模式统一翻译——遇到哪种事件就翻译哪种，不引入 `appType` 配置（见 [03](./03-dify-adapter.md)）。
