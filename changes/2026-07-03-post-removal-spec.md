# 精简后系统规格（post-removal spec）

> 分支 `chore/remove-legacy-surface`（`5d764ba..HEAD`，14 commits，45 files，+836/−2192）落地后的行为契约。
> 本文是**规格**：描述系统现在承诺什么、不再承诺什么，以及升级者会遇到什么。实施过程见 [实施计划](./2026-07-02-remove-legacy-and-low-use-features.md)；实现细节见 `how-it-works/`。

## 1. 移除清单与替代路径

| 移除项 | 原行为 | 现行为 / 替代路径 |
| --- | --- | --- |
| legacy policy 合成（`synthesizeLegacyPolicy`） | 无 `policy` 时从 `guestPolicy`/`access.admins`/`relay.route` 合成受限矩阵 | 无 `policy` = 内置开放默认（人人 `full`、无人中继）；要沙箱/中继必须显式写 `policy` |
| `preferences.guestPolicy`、`relay.route` 字段 | 被静默消费 | **启动/restart 时拒绝**（`assertNoLegacyPolicyFields`，报错指向 CONFIGURATION.zh.md §13 迁移表） |
| `migrate` CLI、`feishu-codex-bridge` 旧路径、`codexBinary`/`codexModel`、`messageReplyMigrated` | 各代升级垫片 | 全部删除；无害旧键出现时打一条非致命 "ignoring removed field" 日志 |
| `messageReply: 'text'` 模式 | 攒完一次性 post | 类型收窄为 `'card' \| 'markdown'`；旧配置 `'text'` **静默回落 markdown** |
| `/timeout`（per-scope idle 覆盖） | 每个 scope 可覆盖看门狗时长 | 只剩全局 `preferences.runIdleTimeoutMinutes`；sessions.json 旧条目中仅含覆盖值的记录首次加载即丢弃 |
| `/account`（聊天内换凭据） | 卡片表单 + 校验 + 自动重启 | CLI：setup 向导 / `secrets set` + `service restart`。**权衡：不再有换凭据前的 token 校验**——写错凭据要到重启连不上才暴露 |
| 云文档评论管线 | 文档评论 @bot 触发 agent | **完全无响应**（事件不注册）；`RelayKind` 收窄为 `message \| cardAction` |
| Windows 守护（schtasks） | 三平台 daemon | 仅 launchd/systemd；win32 执行 service 命令即报错（建议前台 `run` 或 WSL+systemd） |

## 2. 关键行为契约（升级者视角）

- **权限模型只有一条路径**：`effectivePolicy(cfg) = cfg.policy ?? DEFAULT_OPEN_POLICY`。显式 `policy` fail-closed（未命中 rule / profile 名拼错 → `locked`）；无 `policy` fail-open（人人 full）——与旧版"有 guestPolicy 则默认沙箱"**不同**，但旧配置会被启动守卫拦下，不会静默放开。
- **`access` 不是 legacy**：`allowedUsers` / `allowedChats` / `admins` 仍是入口白名单与 admin 命令门控，与 policy 正交、继续生效。
- **relay 无中继目标会告警**：`relay.role: 'front'` 且 policy 中无任何 `run: 'worker'` principal 时启动打 warn（旧的"回落 `access.admins` 自动中继"已随合成层移除——这是最容易被忽略的静默行为变化，故有专门告警 + §13 迁移行）。
- **配置文件级兼容**：`messageReply: 'card'` 手写仍支持（/config 卡片表单已不再提供回复模式选择器）；`'text'` 回落 markdown 不报错。
- **数据文件**：`sessions.json` 结构不变（嵌套 per-profile），仅"裸 idle 覆盖"条目在加载时被清理，无需手动迁移。

## 3. 迁移速查

启动报 `配置包含已移除的 legacy 字段` 时，对照 CONFIGURATION.zh.md §13：

- `guestPolicy.{extraToolAllowlist, commandTools, feishuHostTools, maxToolCalls, systemPrompt}` → 一个受限 `profile` 的同名字段 + 一条兜底 rule。
- `guestPolicy.unrestrictedUsers` → 一个 principal + `{ when: { principal }, profile: 'full' }` rule。
- `relay.route.users`（含"无 route 回落 admins"的隐式形态）→ principal 加 `run: 'worker'`。

## 4. 明确接受的权衡

1. 换凭据无预校验（见 §1 /account 行）。
2. 文档评论场景整体放弃——若未来恢复，应骑在主消息管线上而非重建平行管线（原实现的独立事件循环正是其维护成本根源）。
3. win32 报错经顶层 handler 带堆栈输出（信息完整但不美观）——零用户平台，接受。

## 5. 验证基线

- `pnpm typecheck` / `pnpm test`（150/150，24 个 policy 用例含 4 个 `hasWorkerPrincipal` 新用例）/ `pnpm build` 全绿。
- 冒烟：legacy 配置被拒（报错文案正确指向 §13）；`--help` 无 `migrate`；死引用扫描清零。
- 全部 15 个文档的 mermaid 块与链接锚点机器校验通过；文档基线 hash 与代码同步。
- `pnpm test:guest` 未跑（需真实 omp 环境）；沙箱封锁逻辑由 `guest-lockdown` 单测覆盖。
