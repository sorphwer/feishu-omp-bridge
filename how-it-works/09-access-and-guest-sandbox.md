# 09 · 访问控制与统一策略（principals / profiles / rules）

> 文档基线：commit `a5d981c`（dirty/WIP；此后引入 `src/config/policy.ts` 统一 policy 重构，相关章节待对齐——详见 [README](./README.md)）。

> 覆盖范围：访问控制语义（allowedUsers/allowedChats/admins）；**统一策略模型**（`config/policy.ts` 的 principals×profiles×rules、`resolvePolicy`/`resolveBatchProfile`/`relayRunTarget`、`synthesizeLegacyPolicy` 向后兼容合成、fail-closed 默认）；profile 的应用（`runAgentBatch`、评论、卡片回调）；`guest-lockdown.ts` 的三层封锁、`buildProfileRunArgs`、按 profile 内容签名的产物目录；`command-tools.ts` 的 `buildCommandTools`。
>
> 源文件：`src/config/schema.ts`（access/policy 接口 + 旧 `guestPolicy` 访问器）、`src/config/policy.ts`（统一解析器与合成）、`src/bot/channel.ts`（`runAgentBatch` 应用 profile）、`src/bot/comments.ts`、`src/card/dispatcher.ts`、`src/bot/guest-lockdown.ts`、`src/bot/command-tools.ts`、`src/bot/feishu-host.ts`（host 工具名）。

相关篇：[消息管线](./04-message-pipeline.md)、[飞书 host 工具面](./06-feishu-host-surface.md)、[配置与密钥](./08-config-and-secrets.md)、[聊天命令](./10-commands.md)、[飞书传输/中继](./03-feishu-transport.md)。

## 1. 访问控制语义（`AppAccess`）

`preferences.access { allowedUsers?; allowedChats?; admins? }`，三个列表空/未设 = 不限制（向后兼容）：

- `isUserAllowed(cfg, senderId)`：`allowedUsers` 空 → 允许所有；否则需在列表内。intake 与 cardAction 都查。
- `isChatAllowed(cfg, chatId)`：`allowedChats` 空 → 所有 chat；否则需在列表内。**仅作群门控**——p2p chat_id 按用户对生成、不可冒用，DM 由用户 allowlist 把关。
- `isAdmin(cfg, senderId)`：`admins` 空 → 所有允许用户都是 admin；否则需在列表内。门控敏感命令（见 [10](./10-commands.md)）。

> 注意 `admins` 的**不对称语义**：空 admins 对命令门控 = “人人是 admin”，但对旧 guest/relay 回落 = “无信任用户”。统一策略模型把“谁可信”收敛到 `policy.principals` 一处，消除这种回落链歧义。

访问控制是 profile/run 之外的**正交粗门控**（先决定“能不能进来”），保持不变；扫码向导仍把首个扫码者写进 `admins`（见 [03](./03-feishu-transport.md)）。

## 2. 统一策略模型（`config/policy.ts`）

三条正交、命名的轴，对每条入站事件解析出“用什么工具模式”和“在哪端跑”：

```ts
interface PolicyConfig {
  principals?: Record<string, string[] | { users: string[]; run?: 'front'|'worker' }>;
  profiles?: Record<string, ProfileConfig>;
  rules?: { when?: { chat?; principal?; chatId? }; profile: string }[];
}
interface ProfileConfig {
  tools?: 'all' | string[];      // 'all'/省略 = 全开不沙箱；string[] = 受限（钉死内置工具）
  commandTools?: CommandToolConfig[];
  feishuHostTools?: boolean;      // 默认：full=true，受限=false
  maxToolCalls?: number;         // 每 run 总调用上限（受限才有 hook 强制）
  systemPrompt?: string;         // 前置到 user prompt
  discovery?: 'on' | 'off';      // 默认：full=on，受限=off
  memory?:    'on' | 'off';      // 默认：full=on，受限=off
  extensions?: string[];         // 自定义 OMP 扩展 .mjs hook 路径（--extension），各 profile 一组
}
```

- **WHO `principals`**：命名 open_id 组。未列入任何组者 = 隐式 `guest`（保留名），其 `run` 恒 `front`（陌生人永不转发到 worker）。`principalOf(policy, senderId)` 返回首个含该 id 的组名，否则 `guest`。
- **WHAT `profiles`**：命名工具模式。内置 `full`（全开、无沙箱、feishu host tools 开、discovery/memory 开）与 `locked`（零工具、全关、fail-closed）恒存在。`resolveProfile(name, profiles)` 把名字解析成完全填默认的 `ResolvedProfile`；**未知 profile 名 → `locked`**（不静默放行）。
- **WHEN `rules`**：首条命中（first-match）。`matchRule` 逐条匹配 `when.principal`（含 `guest`）、`when.chat`（p2p/group/topic，其中 `group` 也匹配 `topic`；scenario 未知时带 `chat` 约束的 rule 不命中）、`when.chatId`。
- **WHERE `run`（front/worker）**：**principal 级**属性（不是 per-rule）。`relayRunTarget(cfg, senderId)` = 该 principal 的 `run`（guest 恒 front）。设计成 per-person 而非 per-scenario：保证某人点击的交互卡片回调落在渲染它的同一端，否则会错投（卡片在 front 渲染却把回调转发到 worker）。

`resolvePolicy(cfg, {senderId, chat, chatId})` → `{ principal, run, profile, ruleIndex }`。无 rule 命中 → fail-closed `locked`（`ruleIndex: -1`）。

### 2.1 批次解析与“最严者胜”

一次 debounce run 的 batch 可能含多发送者（群）。`resolveBatchProfile(cfg, senderIds, {chat, chatId})` 取**最严 tier**（locked > 受限 > full）：

- 该 tier 内所有发送者解析到**同一** profile 名 → 原样用（保留其覆写）。
- tier 混杂：full 级差异 → 退回内置 `full`（都不沙箱）；受限/locked 级差异 → fail-closed `locked`（一方的工具集对另一方不安全）。
- 缺 senderId 当 `guest`（fail-closed）。

这复刻并强化了旧的“p2p 且全员可信才全开，否则沙箱”规则。

### 2.2 向后兼容：从旧字段合成

未设 `policy` 时，`effectivePolicy(cfg)` 调 `synthesizeLegacyPolicy(cfg)` 用旧 `access`/`guestPolicy`/`relay.route` 合成等价策略：

- **无 `guestPolicy`**：人人 `full`；`relayTrustedUsers`（`relay.route.users` → 回落 unrestricted → admins）合成一个 `run:'worker'` 的 `relay` principal。
- **有 `guestPolicy`**：合成 `guest` profile（`tools=extraToolAllowlist`、`commandTools`、`feishuHostTools`、`maxToolCalls`、`systemPrompt`、discovery/memory off）。按 full 集（`unrestrictedUsers ?? admins`）与 relay 集忠实拆出 `full_worker`/`full_front`/`relay_only` principals（让 `relay.route.users` 即便仍被沙箱也照常赢得路由）。rules：`{chat:p2p, principal:全权组}→full`，末条 `{profile:'guest'}` 兜底（群/话题、非可信 p2p 全进沙箱）。

故行为与改造前逐位一致；旧 `getGuestPolicy`/`isUnrestrictedUser`/`relayTrustedUsers` 等访问器仍在（作为合成器读的旧字段访问器与测试用）。

### 2.3 显式策略 = fail-closed

一旦设了 `policy`，它是权威：未命中任何 rule 或指向未知 profile → `locked`（零工具），**绝不**回落全集。这与项目“宁锁勿漏”的访客沙箱哲学一致——避免“假锁”（见 [配置](./08-config-and-secrets.md)）。

## 3. profile 的应用点

profile 在**任何 agent 从某发送者起跑处**生效，使策略真正权威（而非又一层假锁）：

- **消息**（`runAgentBatch`，`channel.ts`）：`resolveBatchProfile(cfg, batch.map(senderId), {chat: mode, chatId})`。host 工具面对**所有** profile 都随 profile 走：`feishuHostTools` 开才加飞书 host tools（连带 `feishu://` scheme），加上 profile 的 command tools；`buildProfileRunArgs(profile)` 仅对受限 profile 出 `--tools`+hook，并在 discovery/memory 任一关时出 overlay（故 `full` profile 的这些旋钮也不会被静默忽略）。`profile.systemPrompt` 前置到 prompt。
- **卡片回调**（`card/dispatcher.ts` `forwardToAgent`）：合成消息回灌 `pending` → 走 `runAgentBatch`。合成消息 `chatType` 用真实 `mode`（`group|topic→'group'`，否则 `'p2p'`），避免群里点卡片被当 p2p 拿到更宽 profile。
- **云文档评论**（`comments.ts`）：评论是**共享面**，按 `chat:'group'` 解析评论者 profile 并应用 command tools/沙箱参数/系统提示——堵上了“非可信者评论可跑全工具”的旧绕过（旧实现直接 `agent.run` 无沙箱）。评论无飞书 host 集成，只暴露 command tools。无沙箱配置时仍是全工具（旧行为）。

## 4. 三层封锁（`guest-lockdown.ts`）

`buildProfileRunArgs(profile)` 返回 `GuestRunArgs { tools?; configOverlayPaths; extensionPaths }`，对应 `agent.run` 同名选项。仅受限 profile 出 `--tools`/hook；overlay 按需出；纯 `full` profile 返回空。

1. **`--tools <allowlist>`**（受限才出）：去掉内置工具。`allowlist = builtinTools(=profile.tools) + command tool 名 + （feishuHostTools 开时）飞书 host 工具名`。空则用非空哨兵 `__bridge_no_builtins__`（OMP 把未知名当“什么都不放行”，空 `--tools` 会回落全集）。
   - **修正**：飞书 host 工具名现在**计入** allowlist（来自 `feishu-host.ts` 导出的 `FEISHU_HOST_TOOL_NAMES`），否则 hook 会把刚注册的 host 工具一并拦掉（旧 `getGuestToolAllowlist` 漏了这点）。
2. **`--config <overlay>`**（discovery 或 memory 任一关时出）：`profileOverlayYaml(discovery, memory)`——discovery 关则 `tools.discoveryMode: off` + 列 `disabledProviders`（native/claude/codex/gemini/github/opencode/cursor/agents-md，防继承 operator 个人 MCP 如可任意执行代码的 `node_repl`）；memory 关则 `memory.backend: "off"`（既不能读也不能毒化 operator 记忆库，并禁 retain/recall/reflect）。两者都开 → 返回 `''`，不出 overlay。
3. **`--extension <hook>`**（受限才出）：`profileHookSource(allowlist, limits)` 一个 fail-closed 的 `tool_call` hook——硬拦不在白名单的**一切**工具，并施加每 run 总上限 `MAX_TOTAL` 与每工具上限 `PER_TOOL`。这是真正的执行边界；(1)(2) 只缩小暴露面。
   - **自定义 hook**：`profile.extensions`（在 `policy.ts` 解析：`~`→home、相对→`paths.appDir`、绝对原样）被**追加**到 `extensionPaths`，与自动 hook 叠加（受限）或单独生效（`full`）。`buildProfileRunArgs` 对缺失文件 `log.warn('policy','extension-missing')` 但仍透传——限制器缺失要让 run 失败、不静默消失。仅纯 `full`（无 overlay/hook/extensions）返回空、不写产物。

产物写在 `paths.guestDir/<sig>/`（`<sig>` = `{allowlist, overlay, hook}` 的 sha1 前 12 位），`ensureArtifacts` 幂等 `writeIfChanged` 并按 sig 缓存——**按 profile 内容分目录**，故多个并发 profile 互不覆盖。

> profile 系统提示**前置**到 user prompt，不经 `--append-system-prompt`（给 codex/gpt-5.5 追加系统块会偶发卡死无回复）。改 `policy`/`guestPolicy` 后需整进程 `restart`。

## 5. command tools（`command-tools.ts`）

`buildCommandTools(configs, defaultCwd)` 把每个 `CommandToolConfig` 变成一个 host tool（`normalizeCommandTools` 已校验 name `^[a-zA-Z0-9_]+$`、非空 command、去重、填超时/输出默认；该校验现由 `schema.ts` 导出、profile 解析器复用）：

- 模型只能传 `args: string[]`（argv tokens），`spawn(command, [...args...], { shell:false, cwd })`——**不经 shell**，无法注入管道/重定向/通配/命令拼接，只能跑 `<command> [fixedArgs] [args] [appendArgs]`。
- `allowedSubcommands` 非空时校验 `userArgs[0]` 在集合内。
- `runCommand`：捕获 stdout/stderr，超 `maxBytes`/`timeoutMs` SIGKILL；`isError = timedOut || code!==0`。

这是受限发送者唯一的执行逃生口：raw bash/eval/MCP/文件工具都被去掉，只剩白名单 CLI（如 zendesk_kg/zendesk_docs）。

## 6. 本地回归

`pnpm test`：`config/policy.test.ts`（合成、显式策略、fail-closed、scenario 匹配、batch 最严者胜、混杂受限→locked）、`config/store.test.ts`（YAML 读写往返）、`bot/guest-lockdown.test.ts`（overlay/hook 生成）。

`pnpm test:guest`（`bun scripts/test-guest.ts`，加 `--model` 跑真实模型越权测试）对**真实配置**验证：信任用户全开 / 陌生人进沙箱、危险内置被移除、command tool 注入、shell 注入被挡、白名单外子命令被拒。

## 7. 后端差异

OMP 的 `--tools`/`--config`/hook 封锁依赖“工具在本机、由 CLI 跑”。远程后端（Dify）工具在服务端、无法这样封锁——`dify-feishu-bridge` 改用**访客应用路由**（operator 用 `dify.apiKey`、访客用锁死的 `dify.guestApiKey`），保留信任/systemPrompt 概念，丢弃 `commandTools`/host tools。详见 [dify 配置/会话/访客](../dify-feishu-bridge-design/04-config-session-and-guest.md)。
