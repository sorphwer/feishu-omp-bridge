# 04 · 配置 / 会话 / 访客

> 内容：config diff（删 omp/codex，加 dify 块 + 访问器，示例 config）、secret-resolver 泛化、session 复用（`conversation_id`）、访客重设计（应用路由）、`/switch` 取舍。
>
> 现仓库对应实现：[../how-it-works/08](../how-it-works/08-config-and-secrets.md)（配置/密钥）、[../how-it-works/07](../how-it-works/07-sessions-workspaces-media.md)（会话）、[../how-it-works/09](../how-it-works/09-access-and-guest-sandbox.md)（访问/访客）。

> 同一 `AgentAdapter` 缝也支持在本仓库内并存第二个 adapter 并按 config 选择；本系列按用户指定的独立克隆来写，复用矩阵两种方式都适用。

## 1. 配置 diff（`config/schema.ts`）

删除 preference 字段：`ompBinary`、`ompModel`、`ompThinking`、`ompSessionDir`、`ompTools`、`codexBinary`、`codexModel`（及其访问器 `getOmpBinary`/`getOmpModel`/`getOmpThinking`/`getOmpSessionDir`/`getOmpTools`）。

新增顶层 `dify` 块：

```ts
dify: {
  baseUrl: string;                 // 如 "https://api.dify.ai/v1"
  apiKey: SecretInput;             // app key "app-xxx"；经 SecretRef 复用 keystore
  inputs?: Record<string, string>; // app 默认变量，默认 {}
  guestApiKey?: SecretInput;       // 可选：给访客用的锁死应用
  apps?: Record<string, { apiKey: SecretInput; label?: string }>; // 可选：profile 名 → 专属 app（见 §4），及/或应用选择器
}
```

新增访问器（沿用现有风格）：`getDifyBaseUrl(cfg)`、`getDifyInputs(cfg)`、`getDifyApiKey(cfg)` / `getDifyGuestApiKey(cfg)`（返回 `SecretInput` 给 resolver）、`getDifyApps(cfg)`。

**保持不变**：`accounts.app`、保留的 preferences（`messageReply`/`showToolCalls`/`maxConcurrentRuns`/`runIdleTimeoutMinutes`/`requireMentionInGroup`/`agentStopGraceMs`/`access`）、统一 `policy`（principals/profiles/rules）与 `RelayConfig` 全部不变；仅 **profile 的落地**从“本机工具封锁”变为“选 Dify 应用”（见 §4）。

示例 `config.json`：

```json
{
  "accounts": {
    "app": {
      "id": "cli_xxxxxxxxxxxxxxxx",
      "tenant": "feishu",
      "secret": { "source": "exec", "provider": "dify-feishu-bridge", "id": "app-cli_xxxxxxxxxxxxxxxx" }
    }
  },
  "secrets": {
    "providers": {
      "dify-feishu-bridge": { "source": "exec", "command": "~/.dify-feishu-bridge/secrets-getter" }
    }
  },
  "dify": {
    "baseUrl": "https://api.dify.ai/v1",
    "apiKey": { "source": "exec", "provider": "dify-feishu-bridge", "id": "dify-operator" },
    "inputs": {},
    "guestApiKey": { "source": "exec", "provider": "dify-feishu-bridge", "id": "dify-guest" }
  },
  "preferences": {
    "messageReply": "card",
    "showToolCalls": true,
    "maxConcurrentRuns": 10,
    "requireMentionInGroup": true,
    "access": { "admins": ["ou_xxx"] }
  }
}
```

## 2. secret-resolver 泛化（`config/secret-resolver.ts`）

把 env/file/exec/template 的解析抽成 `resolveSecret(cfg, input: SecretInput, label)`：

- `resolveAppSecret(cfg)` 变成 `resolveSecret(cfg, cfg.accounts.app.secret, 'app')`。
- `dify.apiKey` / `dify.guestApiKey` 同样经 `resolveSecret(cfg, getDifyApiKey(cfg), 'dify')` 解析。

self-bridge exec 短路仍有效（命令是本 bridge 的 `secrets-getter` 时直读 keystore，见 [../how-it-works/08](../how-it-works/08-config-and-secrets.md) §2）。这样 Dify app key 与 App Secret 走同一套加密 keystore + provider 级联，无需新机制。

## 3. session 复用（`conversation_id`）

`session/store.ts` **不变**。`SessionEntry.sessionId` 现在承载 Dify 的 `conversation_id`：

- adapter 在首个带 `conversation_id` 的 chunk emit `system{sessionId}`（见 [03](./03-dify-adapter.md)），`processAgentStream` 调 `sessions.set(scope, sessionId, cwd)` 持久化（见 [../how-it-works/04](../how-it-works/04-message-pipeline.md)、[../how-it-works/07](../how-it-works/07-sessions-workspaces-media.md)）。
- `resumeFor` 的 cwd 匹配仍适用（cwd 对 Dify 仅是信息性，但保留它使 `/cd` 仍会重置会话——cwd 变即 session 视为陈旧）。
- `/new`、`/reset` 清条目 → 下条消息以 `conversation_id:''` 开新 Dify 会话。

## 4. 访客重设计：profile → Dify 应用

OMP 的 `--tools`/`--config`/hook 封锁对 Dify **不可行**（工具在服务端）。统一 policy 的 **WHO/WHEN（principals × rules）保持不变**，只把 **WHAT（profile）** 的落地从“本机工具封锁”换成“**选哪个 Dify 应用**”：

- **profile → Dify app key 映射**：
  - `full`（`restricted:false`）→ operator 应用（`dify.apiKey`，全工具/全知识库）。
  - 任何受限 profile（`restricted:true`）/ 内置 `locked` → 锁死的 guest 应用（`dify.guestApiKey`；未设则回落一个零能力应用或直接拒答）。
  - 命名 profile 可在 `dify.apps[<profileName>]` 显式绑定专属 app key（更细：给不同 principal 配不同受限应用）。
- `runAgentBatch` 与 `comments.ts` 仍调 `resolveBatchProfile(cfg, senders, {chat,chatId})`（**最严者胜**、fail-closed 缺 senderId 当 `guest`，见 [../how-it-works/09](../how-it-works/09-access-and-guest-sandbox.md)），拿到 `ResolvedProfile` 后**按 `profile.name`/`restricted` 选对应 app 的 adapter**，而非 `buildProfileRunArgs`/host 工具封锁。
- `ResolvedProfile` 在 Dify 下**消费**：`name`/`restricted`（选 app）、`systemPrompt`（前置到 query）。**不消费**：`builtinTools`/`commandTools`/`feishuHostTools`/`discovery`/`memory`/`maxToolCalls`/`extensions`——这些是 OMP 本机封锁手段；受限能力改为**内建在对应 Dify 应用里**（在 Dify 控制台为该 app 配好工具/知识库/数据范围）。
- `relayRunTarget`（principal 的 `run`）与 relay 路由**完全不变**（`policy.ts` 那部分后端无关，见 [01](./01-architecture-and-reuse-matrix.md) 矩阵 `config/policy.ts` 行）。
- **向后兼容**：未设 `policy` 时 `synthesizeLegacyPolicy` 仍把旧 `access`/`guestPolicy`/`relay.route` 合成等价策略；Dify 下合成出的 `guest` profile 即映射到 guest 应用。

效果：陌生人/群成员的消息打到锁死的 guest Dify 应用（工具/数据范围在 Dify 侧受限），operator 全权打到 operator 应用。安全边界从“本机 CLI 封锁”上移到“Dify 应用隔离”，而**谁是谁、在哪跑**仍由同一套统一 policy 决定。

## 5. `/switch` 取舍

- **v1：移除**（模型在 Dify 应用内固定，无从客户端切换）。`card/switch-card.ts` DROP、`commands/index.ts` 去 `/switch` handler、`card/templates.ts` 帮助去 `/switch`（见 [01](./01-architecture-and-reuse-matrix.md)、[05](./05-channel-and-commands-adaptation.md)）。
- **可选：应用选择器**。若设了 `dify.apps`，可把 `/switch` 改造成“按 scope 选当前应用”——在 workspace/session 记录上持久化所选 key，`runAgentBatch` 据此选对应 app 的 adapter。本系列把 v1 定为移除，应用选择器作为**可选**记录在案。
