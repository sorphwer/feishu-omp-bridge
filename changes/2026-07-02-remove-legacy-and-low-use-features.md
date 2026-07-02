# 移除 legacy 兼容层与低使用率功能 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除七组功能/兼容层——legacy policy 合成、历代配置垫片、`text` 回复模式、云文档评论管线、`/account` 聊天内换凭据、Windows 守护（schtasks）、`/timeout` per-scope 覆盖——使配置加载、policy 解析、run 渲染三条核心路径各自只剩一条代码路径。

**Architecture:** 纯删除 + 少量"拒绝旧配置"的守卫代码。统一 policy（`principals × profiles × rules`）成为唯一权限模型；无 `policy` 时回落到内置"人人 full"默认。`access`（allowedUsers/allowedChats/admins）**不是** legacy——它是入口白名单 + admin 命令门控，全部保留。

**Tech Stack:** TypeScript, vitest（`pnpm test`）, tsup（`pnpm build`）, tsc（`pnpm typecheck`）。

## Global Constraints

- 基线：main @ `5d764ba`。先建分支 `chore/remove-legacy-surface`，所有 commit 落在该分支。
- 每个 Task 结束时 `pnpm typecheck && pnpm test` 必须全绿再 commit。
- **保留清单（容易误删）**：`access`（AppAccess 全部字段与 `isChatAllowed`/`isUserAllowed`/admin 门控）；`renderText`（markdown 模式和收尾渲染仍用它）；全局 `runIdleTimeoutMinutes` + idle 看门狗 + `RunState.idleTimeoutMinutes`（超时展示用）；`buildEncryptedAccountConfig`（setup 向导 `src/cli/commands/start.ts:335,366,399` 在用）；session store 的 flat→nested `migrateEntry` 主体（本次只删其中 idle-override 相关分支）；`launchd`/`systemd` 守护；relay 本体与 `relayScenarios`。
- 删除函数/类型前先 `grep -rn "<符号名>" src scripts` 确认无余留调用方；删文件后同样 grep 文件名。
- 提交信息用仓库惯例：`refactor(scope): ...` / `chore(scope): ...`，中文正文可选。
- 文档同步（Task 9）统一收口，前面的代码 Task **不要**顺手改 docs，避免冲突。

## 与代码现状的关键事实（写给零上下文的实施者）

- `effectivePolicy`（`src/config/policy.ts:343`）目前是 `cfg.policy ?? synthesizeLegacyPolicy(cfg)`；`synthesizeLegacyPolicy`（`:379`）从 `preferences.guestPolicy`、`preferences.access.admins`、`relay.route.users` 合成 policy。
- `getMessageReplyMode`（`src/config/schema.ts:468`）有 `'text'` + `messageReplyMigrated` 双垫片；`MessageReplyMode`（`:71`）含 `'text'`。
- `src/cli/commands/migrate.ts` 只迁移 pre-0.1.11 的 `feishu-codex-bridge` 旧路径与 `{app}` 旧 shape；`getOmpBinary`/`getOmpModel`（`schema.ts:438,445`）还回落 `codexBinary`/`codexModel` 旧键。
- `/timeout` per-scope 覆盖：`src/commands/index.ts:107,375-425`；`SessionStore` 的 `getIdleTimeoutMinutes`/`setIdleTimeoutMinutes`/`clearIdleTimeoutOverride`（`src/session/store.ts:155-177`）与 `ScopeEntry.idleTimeoutMinutes`；`src/bot/channel.ts:839-847` 的 scope-override 优先逻辑。
- `/account`：`src/commands/index.ts:103,121,683-835` + `src/card/account-cards.ts`（整文件）。
- 评论管线：`src/bot/comments.ts`（整文件）、`channel.ts` 的 `dispatchComment`（`:189,280,345-346,476`）与 `SILENT_COMMENT_API_CODES`（`:68-73` 附近）、`reaction.ts` 的 `addCommentReaction`、relay 三处（`protocol.ts:19,167,183`、`route.ts:88-91`、`worker.ts` comment 分发）。
- schtasks：`src/daemon/schtasks.ts`（整文件）、`service-adapter.ts` 的 win32 分支、`daemon/paths.ts` 的相关路径、`cli/index.ts` 若有引用。

---

### Task 0: 建分支

**Files:** 无代码改动。

- [ ] **Step 1:** `git checkout -b chore/remove-legacy-surface`（当前在 main @ 5d764ba，工作树须干净）。

---

### Task 1: 删除 legacy policy 合成器

**Files:**
- Modify: `src/config/policy.ts`（删 `:340-417` 的 `unrestrictedSet` / `guestProfileFromLegacy` / `synthesizeLegacyPolicy` 及其相关 import；改 `effectivePolicy`）
- Modify: `src/config/policy.test.ts`（删合成器测试，加默认 policy 测试）

**Interfaces:**
- Produces: `effectivePolicy(cfg): PolicyConfig`——签名不变；无 `cfg.policy` 时返回内置 `DEFAULT_OPEN_POLICY`（人人 `full`、无 relay principal）。Task 2 依赖此行为。
- `synthesizeLegacyPolicy` 从 export 中消失；`grep -rn synthesizeLegacyPolicy src` 结果须为空。

- [ ] **Step 1: 写失败测试**（`src/config/policy.test.ts`，替换原 synthesize 相关 describe）：

```ts
describe('effectivePolicy without explicit policy', () => {
  it('falls back to everyone-full, nobody-relayed', () => {
    const cfg = {} as AppConfig;
    const p = effectivePolicy(cfg);
    expect(p.rules).toEqual([{ profile: 'full' }]);
    expect(Object.keys(p.principals ?? {})).toHaveLength(0);
    const { profile } = resolveBatchProfile(cfg, ['ou_anyone'], { chat: 'group' });
    expect(profile.name).toBe('full');
    expect(relayRunTarget(cfg, 'ou_anyone', 'p2p')).toBe('front');
  });
});
```

- [ ] **Step 2:** `pnpm test -- policy` → 新 describe FAIL（旧合成器仍会因 relay/guestPolicy 缺省而恰好通过部分断言，但删除旧 synthesize 测试后 import 报错先出现——正常，继续）。
- [ ] **Step 3: 实现**——`policy.ts` 删除三个 legacy 函数与 `GuestToolPolicy`/`getGuestPolicy`/`relayTrustedUsers` 相关 import，`effectivePolicy` 改为：

```ts
/** Policy when none is configured: everyone runs `full`, nothing relays. */
const DEFAULT_OPEN_POLICY: PolicyConfig = {
  principals: {},
  profiles: {},
  rules: [{ profile: 'full' }],
};

/** The explicit policy when set, else the built-in open default. */
export function effectivePolicy(cfg: AppConfig): PolicyConfig {
  return cfg.policy ?? DEFAULT_OPEN_POLICY;
}
```

- [ ] **Step 4:** 删 `policy.test.ts` 中所有针对 `synthesizeLegacyPolicy` / legacy 合成矩阵的测试块；`pnpm typecheck && pnpm test` 全绿。
- [ ] **Step 5:** `git commit -m "refactor(policy): drop legacy access/guestPolicy/relay.route synthesis"`

---

### Task 2: 删除 legacy 配置字段 + 启动期拒绝

**Files:**
- Modify: `src/config/schema.ts`（删 `GuestToolPolicy` 接口、`preferences.guestPolicy` 字段 `:212`、`getGuestPolicy` `:553`、unrestrictedUsers 帮手 `:587`、legacy guest command-tools 包装 `:649` 附近——共享的 command-tool 校验器 `normalizeCommandTools` 若同时服务 profiles 则**保留**；删 `RelayConfig.route` `:250-256`；新增 `assertNoLegacyPolicyFields`）
- Modify: `src/cli/commands/start.ts`（config 加载后调用守卫）
- Modify: `src/config/schema.test.ts`、`src/bot/guest-lockdown.test.ts`（若引用 GuestToolPolicy 则改用 ProfileConfig 构造）

**Interfaces:**
- Produces: `assertNoLegacyPolicyFields(cfg: Partial<AppConfig>): void`——检出 `preferences.guestPolicy` / `relay.route` 即 throw。

- [ ] **Step 1: 写失败测试**（`schema.test.ts`）：

```ts
describe('assertNoLegacyPolicyFields', () => {
  it('rejects preferences.guestPolicy', () => {
    expect(() =>
      assertNoLegacyPolicyFields({ preferences: { guestPolicy: {} } } as never),
    ).toThrow(/guestPolicy/);
  });
  it('rejects relay.route', () => {
    expect(() =>
      assertNoLegacyPolicyFields({ relay: { role: 'front', route: { users: [] } } } as never),
    ).toThrow(/relay\.route/);
  });
  it('passes a clean config', () => {
    expect(() => assertNoLegacyPolicyFields({})).not.toThrow();
  });
});
```

- [ ] **Step 2:** `pnpm test -- schema` → FAIL（函数不存在）。
- [ ] **Step 3: 实现**（`schema.ts`）：

```ts
/**
 * Legacy fields removed with the unified policy model. Fail FAST at startup —
 * silently ignoring security-relevant config would fail open.
 */
export function assertNoLegacyPolicyFields(cfg: Partial<AppConfig>): void {
  const offenders: string[] = [];
  const prefs = cfg.preferences as Record<string, unknown> | undefined;
  if (prefs && 'guestPolicy' in prefs) offenders.push('preferences.guestPolicy');
  const relay = cfg.relay as Record<string, unknown> | undefined;
  if (relay && 'route' in relay) offenders.push('relay.route');
  if (offenders.length > 0) {
    throw new Error(
      `配置包含已移除的 legacy 字段：${offenders.join('、')}。` +
        `请迁移到统一 policy（见 CONFIGURATION.zh.md §9）：` +
        `guestPolicy → profiles + rules；relay.route.users → principals.<组>.run: "worker"。`,
    );
  }
}
```

在 `src/cli/commands/start.ts` 的 `runStart` 中，`loadConfig` 返回后立即 `assertNoLegacyPolicyFields(cfg)`（找到现有 `const cfg = await loadConfig(...)` 或等价装配点，紧随其后插入）。

- [ ] **Step 4:** 删 `GuestToolPolicy` 及上述 schema 死代码；跑 `grep -rn "guestPolicy\|GuestToolPolicy\|getGuestPolicy" src scripts`，清掉所有余留（`scripts/test-guest.ts` 若用 legacy 构造则改为 policy/profiles 构造）。`pnpm typecheck && pnpm test` 全绿。
- [ ] **Step 5:** `git commit -m "refactor(config): remove guestPolicy/relay.route fields, fail fast on legacy config"`

---

### Task 3: 删除 `text` 回复模式 + `messageReplyMigrated`

**Files:**
- Modify: `src/config/schema.ts:71`（`MessageReplyMode = 'card' | 'markdown'`）、`:170-179`（删 `messageReplyMigrated`）、`:468-474`（简化 `getMessageReplyMode`）
- Modify: `src/bot/channel.ts`（删 `replyMode === 'text'` 分支——即 `driveAgent` 之后 "text mode: drain..." 的 else 段 `:955-968` 附近）
- Modify: `src/card/config-card.ts:52`（删 `'纯文本'` 选项）
- Modify: `src/commands/index.ts:897`（校验集合去掉 `'text'`；`/config` 提交处若写 `messageReplyMigrated: true` 一并删）
- Modify: `src/config/schema.test.ts`

**Interfaces:**
- Produces: `getMessageReplyMode(cfg): 'card' | 'markdown'`。旧配置里的 `messageReply: 'text'`（类型外值）静默回落 `'markdown'`，**不报错**。

- [ ] **Step 1: 写失败测试**：

```ts
it('coerces removed text mode to markdown', () => {
  const cfg = { preferences: { messageReply: 'text' } } as never;
  expect(getMessageReplyMode(cfg)).toBe('markdown');
});
it('defaults to markdown', () => {
  expect(getMessageReplyMode({} as never)).toBe('markdown');
});
```

- [ ] **Step 2:** `pnpm test -- schema` → 第一条 FAIL（当前 `messageReplyMigrated !== true` 时已回落 markdown，但删除字段后逻辑变化；以最终实现为准）。
- [ ] **Step 3: 实现**：

```ts
export function getMessageReplyMode(cfg: AppConfig): MessageReplyMode {
  const raw = cfg.preferences?.messageReply;
  if (raw === 'card' || raw === 'markdown') return raw;
  return 'markdown';
}
```

`channel.ts`：`replyMode` 只剩 card/markdown 两分支，else 即 markdown 路径；删除 text 段与其注释。`renderText` 本体**保留**。

- [ ] **Step 4:** `grep -rn "messageReplyMigrated\|'text'" src --include="*.ts" | grep -v input_type | grep -v test` 清余留；`pnpm typecheck && pnpm test`。
- [ ] **Step 5:** `git commit -m "refactor(reply): drop text reply mode and messageReplyMigrated shim"`

---

### Task 4: 垫片清算——`migrate` 命令、旧路径、`codex*` 别名

**Files:**
- Delete: `src/cli/commands/migrate.ts`
- Modify: `src/cli/index.ts:3` + migrate 子命令注册段
- Modify: `src/config/paths.ts`（删 `legacyPaths`）
- Modify: `src/config/schema.ts:438-449`（`getOmpBinary`/`getOmpModel` 删 `codexBinary`/`codexModel` 回落）+ preferences 里对应字段声明
- Modify: 相关测试

**Interfaces:**
- Produces: `getOmpBinary(cfg)` 只读 `preferences.ompBinary`；`getOmpModel(cfg)` 只读 `preferences.ompModel`。CLI 不再有 `migrate` 子命令。

- [ ] **Step 1: 写失败测试**（`schema.test.ts`）：

```ts
it('ignores legacy codexBinary alias', () => {
  const cfg = { preferences: { codexBinary: '/usr/bin/fake' } } as never;
  expect(getOmpBinary(cfg)).toBe('omp');
});
```

- [ ] **Step 2:** `pnpm test -- schema` → FAIL（当前会回落 codexBinary）。
- [ ] **Step 3: 实现**：删别名回落与字段；删 migrate.ts 与注册；删 `legacyPaths`（`grep -rn legacyPaths src` 确认仅 migrate 在用）。
- [ ] **Step 4:** `pnpm typecheck && pnpm test`；`node dist` 不需验证（build 在 Task 10）。
- [ ] **Step 5:** `git commit -m "chore(cli): remove pre-0.1.11 migrate command, legacy paths and codex* aliases"`

---

### Task 5: 删除 `/timeout` per-scope 覆盖

**Files:**
- Modify: `src/commands/index.ts`（删 `:107` 注册、`handleTimeout :375-425`、help 文案中 /timeout 行）
- Modify: `src/session/store.ts`（删 `ScopeEntry.idleTimeoutMinutes`、`getIdleTimeoutMinutes`/`setIdleTimeoutMinutes`/`clearIdleTimeoutOverride`、`migrateEntry` 中"裸 idle override 也保留"的分支——`sessions` 为空且无 override 即 drop 的逻辑简化为 `sessions` 为空即 drop、`set()` 中 override 保留逻辑）
- Modify: `src/bot/channel.ts:839-847`（idle 解析只剩 `getRunIdleTimeoutMs(controls.cfg)`）
- Modify: `src/session/store.test.ts`、`src/card/templates.ts`（statusCard/help 若展示 per-scope timeout 行则删）

**Interfaces:**
- Produces: `ScopeEntry = { sessions: Record<string, ProfileSession>; updatedAt: number }`。全局 `runIdleTimeoutMinutes`（preferences）与看门狗、`RunState.idleTimeoutMinutes` 展示字段**不动**。

- [ ] **Step 1: 写失败测试**（`store.test.ts`，替换 idle-override 相关用例）：

```ts
it('drops legacy entries that only carried an idle override', async () => {
  // 旧 JSON：{"chat1": {"idleTimeoutMinutes": 30, "updatedAt": 1}}
  // load 后该 scope 不应存在
  await writeFixture({ chat1: { idleTimeoutMinutes: 30, updatedAt: 1 } });
  await store.load();
  expect(store.latestSession('chat1')).toBeUndefined();
});
```

（`writeFixture` 按现有测试文件的既有写盘辅助改写——store.test.ts 里已有同类 helper，沿用其模式。）

- [ ] **Step 2:** `pnpm test -- session` → FAIL。
- [ ] **Step 3: 实现**：按 Files 清单删除；channel.ts 该段变为：

```ts
const idleTimeoutMs = getRunIdleTimeoutMs(controls.cfg);
```

- [ ] **Step 4:** `grep -rn "idleTimeoutMinutes" src --include="*.ts" | grep -v run-state | grep -v run-renderer | grep -v text-renderer | grep -v "runIdleTimeoutMinutes"` 应为空；`pnpm typecheck && pnpm test`。
- [ ] **Step 5:** `git commit -m "refactor(session): drop per-scope /timeout override, global idle timeout only"`

---

### Task 6: 删除 `/account` 聊天内换凭据

**Files:**
- Delete: `src/card/account-cards.ts`
- Modify: `src/commands/index.ts`（删 `:7-11` import、`:103` 注册、`:121` ADMIN_COMMANDS 项、`:683-835` 附近整个 /account 段——含表单卡回调 handler、`validateAppCredentials` 若只被它用则一并删/移；help 文案）
- Modify: `src/card/dispatcher.ts`（若有 account 专属路由值则删；`grep -n account src/card/dispatcher.ts` 确认）
- Modify: 相关测试

**Interfaces:**
- Consumes: `buildEncryptedAccountConfig`（`src/config/store.ts:69`）**保留**——setup 向导仍用。
- Produces: 无 `/account` 命令；换凭据的唯一路径 = CLI（向导 / `secrets set` + `service restart`）。

- [ ] **Step 1:** `grep -rn "account" src/commands/index.ts src/card/ --include="*.ts" | grep -v Account 之外的误报`，圈定精确删除范围（注意 `accounts.app` 是活跃配置结构，别碰）。
- [ ] **Step 2:** 删除上述范围；`validateAppCredentials` 若 setup 向导（start.ts）也在用则保留原位。
- [ ] **Step 3:** `pnpm typecheck && pnpm test` 全绿；手动 `grep -rn "account-cards\|accountFormCard\|handleAccount" src` 为空。
- [ ] **Step 4:** `git commit -m "refactor(commands): remove /account in-chat credential flow (CLI covers it)"`

---

### Task 7: 删除云文档评论管线

**Files:**
- Delete: `src/bot/comments.ts`
- Modify: `src/bot/channel.ts`（删 `CommentEvent` import、`SILENT_COMMENT_API_CODES` `:68-73`、`dispatchComment` 接口字段 `:189`、装配 `:280`、事件注册 `:345-346`、relay worker 分发 case `:476`）
- Modify: `src/bot/reaction.ts`（删 `addCommentReaction`）
- Modify: `src/relay/protocol.ts`（`RelayKind = 'message' | 'cardAction'`；删 `commentId`/`replyId` 字段 `:167` 与 `naturalId` comment 分支 `:183`）
- Modify: `src/relay/route.ts`（删 `routeComment` `:85-91` 与接口声明）
- Modify: `src/relay/worker.ts`（删 comment kind 分发）
- Modify: 相关测试

**Interfaces:**
- Produces: `RelayRouter = { routeMessage; routeCardAction }`；`BridgeRuntime` 无 `dispatchComment`。@bot 的文档评论从此**无响应**（SDK 事件不再注册）。

- [ ] **Step 1:** 确认 SDK 侧注册点：`grep -n "comment" src/bot/channel.ts`——事件 handler 对象里的 `comment:` 键即注册处，删除后 SDK 不订阅该事件。
- [ ] **Step 2:** 按 Files 清单删除；`grep -rn "CommentEvent\|handleCommentMention\|routeComment\|addCommentReaction" src` 为空。
- [ ] **Step 3:** `pnpm typecheck && pnpm test` 全绿（`relay` 相关测试若枚举三种 kind 需同步收窄为两种）。
- [ ] **Step 4:** `git commit -m "refactor(bot): remove cloud-doc comment pipeline"`

---

### Task 8: 删除 Windows 守护（schtasks）

**Files:**
- Delete: `src/daemon/schtasks.ts`
- Modify: `src/daemon/service-adapter.ts`（win32 分支改为明确报错）
- Modify: `src/daemon/paths.ts`（删 schtasks 专属路径）
- Modify: `src/cli/index.ts`（若引用）
- Modify: 相关测试

**Interfaces:**
- Produces: `requireAdapter()`（或现有等价选择函数）在 `process.platform === 'win32'` 时 throw：

```ts
throw new Error('Windows 守护进程支持已移除；请前台运行 `feishu-omp-bridge run`，或用 WSL + systemd。');
```

- [ ] **Step 1:** `grep -rn "schtasks\|win32" src/daemon src/cli --include="*.ts"` 圈定范围。
- [ ] **Step 2:** 删除 + 替换 win32 分支为上述报错；`pnpm typecheck && pnpm test`。
- [ ] **Step 3:** `git commit -m "chore(daemon): drop Windows schtasks support"`

---

### Task 9: 文档同步

**Files:**
- Modify: `CONFIGURATION.zh.md`（§13 向后兼容整节改写为"legacy 字段已移除 + 迁移对照表"；删 /timeout、/account、text 模式、评论、Windows 相关内容；troubleshooting 同步）
- Modify: `README.md`、`README.zh.md`（命令表、功能列表、平台支持、legacy 提示）
- Modify: `how-it-works/`：03（relay comment kind、routeComment）、04（text 分支、评论入口、idle override）、05（config-card 选项、account 卡）、07（ScopeEntry 无 idleTimeoutMinutes、migrateEntry 简化）、08（schema 字段、synthesizeLegacyPolicy、codex 别名、migrate）、09（合成器整节删除、fail-fast 守卫）、10（/timeout、/account 移除）、11（schtasks、migrate 子命令）、README（术语表 + 基线 hash 刷新为本分支最终 commit）
- Modify: `changes/` 本计划文件的 checkbox 状态

**Interfaces:** 无代码。核对方式：对每个被删符号 `grep -rn "<符号>" how-it-works CONFIGURATION.zh.md README*.md`，命中即改。

- [x] **Step 1:** 逐文件按上述清单改写；mermaid 图中出现被删元素（comment 路由、text 分支、/timeout）的一并更新。
- [x] **Step 2:** 用 scratchpad 里的 `check-mermaid.mjs` + `check-links.js` 校验全部图与链接。
- [x] **Step 3:** `git commit -m "docs: sync docs after legacy/low-use feature removal"`

---

### Task 10: 终验

- [ ] **Step 1:** `pnpm typecheck && pnpm test && pnpm build` 全绿。
- [ ] **Step 2:** 死引用扫描（应全部为空）：

```bash
grep -rn "synthesizeLegacyPolicy\|guestPolicy\|GuestToolPolicy\|messageReplyMigrated\|codexBinary\|codexModel\|legacyPaths\|handleTimeout\|account-cards\|handleAccount\|CommentEvent\|routeComment\|addCommentReaction\|schtasks" src scripts --include="*.ts"
```

- [ ] **Step 3:** `pnpm test:guest --model <常用模型>`（访客沙箱回归，确认 profile 封锁不受影响；需要真实 omp 环境，跑不了就标注跳过原因）。
- [ ] **Step 4:** 冒烟：`node dist/cli.js --help` 确认无 `migrate` 子命令；构造含 `guestPolicy` 的临时 config 启动应报迁移错误。
- [ ] **Step 5:** `git commit`（若有残余修补），汇报分支就绪。

## Self-Review 结论

- 七项覆盖：①合成器=Task1+2；②垫片=Task4（+Task3 的 messageReplyMigrated）；③text=Task3；④评论=Task7；⑤/account=Task6；⑥schtasks=Task8；⑦/timeout=Task5。文档=Task9，终验=Task10。
- 类型一致性：`effectivePolicy`/`assertNoLegacyPolicyFields`/`getMessageReplyMode`/`ScopeEntry` 的最终签名在各 Task 的 Interfaces 块中唯一定义，无冲突。
- 风险点已入约束：`access` 保留、`renderText` 保留、`buildEncryptedAccountConfig` 保留、migrateEntry 主体保留。
