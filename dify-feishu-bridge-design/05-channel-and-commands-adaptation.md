# 05 · 通道与命令适配

> 内容：ADAPT 文件的精确改动——`channel.ts`、`start.ts`、`commands/index.ts`、`templates.ts`/`config-card.ts`、daemon/paths 重命名、`preflight.ts`。
>
> 现仓库对应实现：[../how-it-works/04](../how-it-works/04-message-pipeline.md)（channel）、[../how-it-works/01](../how-it-works/01-overview-and-architecture.md)（start）、[../how-it-works/10](../how-it-works/10-commands.md)（命令）、[../how-it-works/11](../how-it-works/11-daemon-cli-runtime.md)（daemon/cli）。

> 同一 `AgentAdapter` 缝也支持在本仓库内并存第二个 adapter 并按 config 选择；本系列按用户指定的独立克隆来写，复用矩阵两种方式都适用。

## 1. `bot/channel.ts` · `runAgentBatch`

四处改动（其余 intake/去抖/池/processAgentStream/回复模式不变）：

1. **传 `user` + `attachments`**：`agent.run({...})` 增 `user: firstMsg.senderId`（fallback `chatId`）、`attachments`（完整 `LocalAttachment[]`，来自 `media.resolve(...)`）。见 [01](./01-architecture-and-reuse-matrix.md) §3。
2. **删 host 集成**：移除 `createFeishuHostIntegration(...)` 块及 `hostTools`/`hostUriSchemes` 参数（Dify 忽略它们；`feishu-host.ts` 已 DROP）。
3. **profile → adapter**：把 profile 落地块（现为 `buildProfileRunArgs` + `buildCommandTools` + host 工具 + 前置 prompt）替换为**适配器选择**——`resolveBatchProfile(...)` 拿到 `profile` 后，按 `profile.restricted`/`profile.name` 选对应 Dify 应用的 adapter（`full`→operator、受限/`locked`→guest、命名 profile→`dify.apps`），`profile.systemPrompt` 仍前置到 query。`resolveBatchProfile`/principals/rules 调用本身不变。见 [04](./04-config-session-and-guest.md) §4。
4. **`buildPrompt` 去本地路径附录**：Dify 远程运行，本地路径无意义。删掉“附件（本地路径）：”列表；附件改走请求的 `files[]`（经 `files.ts` 上传，见 [03](./03-dify-adapter.md)）。如需，仅追加上传文件的**名字**（或什么都不追加）。**保留** `<bridge_context>` / `<quoted_message>` / `<interactive_card>` 注入（飞书上下文唯一进 app 的通道）。

`runAgentBatch` 如何拿到多个 adapter：由 `createBridgeRuntime`/`StartChannelDeps` 携带一个 **profile→adapter 解析器**（operator + guest 两实例起步，命名 profile 各自一实例，见 §2），按 `resolveBatchProfile` 的结果选用。

## 2. `cli/commands/start.ts`

把 `OmpAdapter` 构造 + `listModels/listAuthenticatedProviders/getModelRoles` 探测（现仓库 `runStart` 里那段）替换为：

```ts
const agent = new DifyAdapter({ baseUrl: getDifyBaseUrl(cfg), apiKey: await resolveSecret(cfg, getDifyApiKey(cfg), 'dify'), inputs: getDifyInputs(cfg) });
const guestKey = getDifyGuestApiKey(cfg);
const guestAgent = guestKey ? new DifyAdapter({ baseUrl: getDifyBaseUrl(cfg), apiKey: await resolveSecret(cfg, guestKey, 'dify-guest'), inputs: getDifyInputs(cfg) }) : agent;
```

删掉模型目录写入（`setModelCatalog`/`setAuthenticatedProviders`/`setModelRoles`）与 “✗ 未找到 omp CLI” 文案/`process.exit(1)`（改为 `DifyAdapter.isAvailable()` 非致命探测）。其余（stores、`gcMediaCache`/`gcOldLogs`、冲突检测、registry、controls、`startBridge`、信号、未捕获异常网）**不变**。把 `agent`（与 `guestAgent`）经 `StartChannelDeps` 传入。

## 3. `commands/index.ts`

- 移除 `/switch` handler + 其卡片引用（`handleSwitch`/`showSwitchForm`/`submitSwitch`/`cancelSwitch`、`switch-card` import）。从 `handlers` 表与 `ADMIN_COMMANDS` 去掉 `/switch`。
- `/status` 的 agent 行显示 `Dify` + app 标签（`ctx.agent.displayName` 已是 `'Dify'`；可附 `getDifyApps` 的当前 app label）。
- `/doctor` 继续工作：把最近日志当普通 Dify query 发（`ctx.agent.run({prompt, user, ...})`，session-less 仍跳过 `system`）。
- `/new chat`（飞书 `im:chat` 建群）不变。其余命令不变。

## 4. `card/templates.ts` / `card/config-card.ts`

- `templates.ts`：帮助文案删 `/switch` 行与“🔀 切换模型”按钮（`{cmd:'switch'}`）。
- `config-card.ts`：把用户可见的 `~/.feishu-omp-bridge/config.json`、`~/.feishu-omp-bridge/logs/*.log` 改为 `~/.dify-feishu-bridge/...`；admin 命令帮助里去掉 `/switch`。表单字段逻辑不变。

## 5. 数据根 / 服务标识 / 包名重命名

- `config/paths.ts`：`appDir = ~/.dify-feishu-bridge`（其余键派生自它，自动跟随）。
- `daemon/paths.ts`：`SERVICE_NAME='dify-feishu-bridge.bot'`、`LAUNCH_AGENT_LABEL='ai.dify-feishu-bridge.bot'`、`SYSTEMD_UNIT_NAME='dify-feishu-bridge.bot.service'`、`WINDOWS_TASK_NAME='DifyFeishuBridge.Bot'`、`windowsLauncherCmdPath` 跟随 `paths.appDir`。
- `relay/protocol.ts`：`KEY_LABEL` → `dify-feishu-bridge/relay/v1`。
- `package.json`：`name`/`bin` → `dify-feishu-bridge`；`bin/dify-feishu-bridge.mjs`。
- `cli/index.ts`：commander `.name('dify-feishu-bridge')` + 描述；`secrets` 描述里的 `secrets.enc` 路径；`channel.ts` 的 `source: 'dify-feishu-bridge'`；`ps.ts`/`secrets.ts` 用法串。

## 6. `cli/preflight.ts`

保留 lark-cli 自动安装/绑定（飞书侧不变）。删 OMP 可用性检查（现仓库无；OMP 检查在 `start.ts` 的 `agent.isAvailable()`，已随 §2 改造）。加可选 Dify 连通性探测：用配置的 key `GET {baseUrl}/parameters`，失败仅告警不致命。

## 7. 不变清单（强调）

`processAgentStream`、`reduce()`/`renderCard`/`renderText`/`tool-render`、`managed`/`dispatcher`/`omp-ui`、`PendingQueue`/`ProcessPool`/`ActiveRuns`、`session`/`workspace`/`media` store、`registry`/`logger`、`daemon` 三平台实现、`relay` front/route/worker、`keepalive`/`network-config`/`quote`/`interactive-card`/`group`/`reaction`/`comments`/`wizard`/`feishu-auth` —— 全部不动。这正是“只有一条缝在变”的体现（见 [README](./README.md)、[01](./01-architecture-and-reuse-matrix.md)）。

## 8. 行为保真一致性（与 [03](./03-dify-adapter.md) 呼应）

- `submitPrompt` 省略 ⇒ mid-run 跟进/steer **排到下一轮**（靠 `conversation_id` 续聊），`!` 前缀失效——见 [03](./03-dify-adapter.md) §5、[../how-it-works/04](../how-it-works/04-message-pipeline.md) §3。
- `respondToUi` 省略 ⇒ 交互卡片休眠（`omp-ui`/dispatcher `__omp_ui` 分支保留无害）。
- host tools / `feishu://` 不可用 ⇒ 飞书上下文经 `buildPrompt` 注入（本篇 §1 第 4 点保留 `<bridge_context>` 等）。
