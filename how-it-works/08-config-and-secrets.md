# 08 · 配置与密钥

> 文档基线：commit `a5d981c`（dirty/WIP；此后引入 `src/config/policy.ts` 统一 policy 重构，相关章节待对齐——详见 [README](./README.md)）。

> 覆盖范围：`config/schema.ts` 的完整 `AppConfig` 层级（含每个 preference 字段、默认值、clamp）与所有访问器；`config/store.ts`（原子写、加密账户配置、secrets-getter 包装脚本）；`config/paths.ts`（全部路径 + `legacyPaths`）；`config/secret-resolver.ts`（plain→template→env→file→exec 五段管线、self-bridge 短路、provider 级联）；`config/keystore.ts`（AES-256-GCM、PBKDF2-SHA256 10 万次、host 派生种子 + 盐文件、`secrets.enc` 形状）。
>
> 源文件：`src/config/schema.ts`、`src/config/store.ts`、`src/config/paths.ts`、`src/config/secret-resolver.ts`、`src/config/keystore.ts`、`README.md`（安全说明）。

相关篇：[总览与架构](./01-overview-and-architecture.md)（数据目录、启动迁移）、[访问控制与访客沙箱](./09-access-and-guest-sandbox.md)、[聊天命令](./10-commands.md)（`/config`/`/account`）、[守护进程与 CLI 运行时](./11-daemon-cli-runtime.md)（`secrets` 子命令）。

## 1. `AppConfig` 层级（`config/schema.ts`）

```ts
interface AppConfig {
  accounts: { app: AppCredentials };
  secrets?: SecretsConfig;
  preferences?: AppPreferences;
  relay?: RelayConfig;
  policy?: PolicyConfig;   // 统一 principals/profiles/rules（见 §1.3 与 [09]）
}
```

- `AppCredentials { id; secret: SecretInput; tenant: 'feishu'|'lark' }`。
- `SecretInput = string | SecretRef`；`SecretRef { source:'env'|'file'|'exec'; provider?; id }`。`isSecretRef(s)` 判对象形态。
- `SecretsConfig { providers?: Record<name, ProviderConfig>; defaults?: {env?;file?;exec?} }`。`ProviderConfig { source; allowlist?; path?; command?; args?; env?; passEnv?; noOutputTimeoutMs?; maxOutputBytes? }`（openclaw / lark-cli 兼容）。
- `isComplete(cfg)`：`app.id && hasSecret(app.secret) && app.tenant`。
- `secretKeyForApp(appId)`：`app-${appId}`（keystore 键约定，与 lark-cli 一致）。

### 1.1 `AppPreferences` 全字段

| 字段 | 默认 | clamp / 说明 | 访问器 |
| --- | --- | --- | --- |
| `ompBinary` | `omp` | OMP 可执行名/路径 | `getOmpBinary` |
| `ompModel` | 未设 | `--model`，留空由 OMP 配置决定 | `getOmpModel` |
| `ompThinking` | 未设 | `--thinking` | `getOmpThinking` |
| `ompSessionDir` | `~/.feishu-omp-bridge/omp-sessions` | bridge 专用 session 目录 | `getOmpSessionDir` |
| `ompTools` | 未设 | `--tools` 逗号白名单（全局，对所有人） | `getOmpTools` |
| `codexBinary` | 未设 | 旧 Codex 可执行名，仅 `ompBinary` 缺失时用（遗留） | （`getOmpBinary` 回落） |
| `codexModel` | 未设 | 旧 Codex 模型，仅 `ompModel` 缺失时用（遗留） | （`getOmpModel` 回落） |
| `messageReply` | `card` | `card`/`markdown`/`text`；旧值 `text` 经 `messageReplyMigrated` 自动 coerce | `getMessageReplyMode` |
| `messageReplyMigrated` | — | 内部迁移标记（0.1.27 重命名语义） | — |
| `showToolCalls` | `true` | `!== false`；关则隐藏工具调用块 | `getShowToolCalls` |
| `maxConcurrentRuns` | `10` | clamp `[1,50]` | `getMaxConcurrentRuns` |
| `runIdleTimeoutMinutes` | 关闭 | 全局 idle kill 分钟；0/未设 = 关 | `getRunIdleTimeoutMs`（×60000） |
| `requireMentionInGroup` | `true` | `!== false`；群是否必须 @bot | `getRequireMentionInGroup` |
| `access` | — | 见 [09](./09-access-and-guest-sandbox.md) | `isUserAllowed`/`isChatAllowed`/`isAdmin` |
| `guestPolicy` | — | 见 [09](./09-access-and-guest-sandbox.md) | `getGuestPolicy` 等 |
| `agentStopGraceMs` | `5000` | 范围 `[100,30000]`，越界回落默认 | `getAgentStopGraceMs` |

`getMessageReplyMode` 默认 `card`（README 偏好表写默认 `markdown`，代码访问器实为 `card`——以代码为准）。

### 1.2 `RelayConfig`（见 [03](./03-feishu-transport.md)）

```ts
interface RelayConfig {
  role: 'front'|'worker';
  listen?: string;     // front 绑定，默认 127.0.0.1:8787
  endpoint?: string;   // worker 必填：front base URL
  route?: { users?: string[] };  // front 转发哪些 open_id
  workerId?: string;   // 默认 hostname
}
```

访问器：`getRelayConfig`、`relayTrustedUsers`（显式 `route.users` → 回落非空 `guestPolicy.unrestrictedUsers` → 回落非空 `access.admins`；都空 = 不转发任何人，fail-safe）、`isRelayTrusted(cfg, senderId)`（遗留；新路由用 `policy.ts` 的 `relayRunTarget`，见 [09](./09-access-and-guest-sandbox.md)）。认证用从 App Secret 派生的 HMAC，无需额外密钥。

### 1.3 `PolicyConfig`（统一访问策略，见 [09](./09-access-and-guest-sandbox.md)）

```ts
interface PolicyConfig {
  principals?: Record<string, string[] | { users: string[]; run?: 'front'|'worker' }>;
  profiles?: Record<string, ProfileConfig>;   // 命名工具模式；内置 full / locked 恒存在
  rules?: { when?: { chat?; principal?; chatId? }; profile: string }[];  // first-match
}
```

- **正交三轴**：`principals`=谁（命名 open_id 组；未列入者即隐式 `guest`，且 `run` 恒 `front`）、`profiles`=放什么工具（`tools:'all'`=全开不沙箱；`tools:string[]`=受限沙箱）、`rules`=何时（`chat`(p2p/group/topic，`group` 亦匹配 `topic`) × `principal` × `chatId` 首条命中）。`run`(front/worker) 是 **principal 级**属性（非 per-rule），保证某人交互卡片回调落在渲染它的同一端。
- **缺省 = 向后兼容**：未设 `policy` 时，`policy.ts` 的 `synthesizeLegacyPolicy` 用旧 `access`/`guestPolicy`/`relay.route` 合成等价策略；行为与改造前完全一致。
- **显式 = fail-closed**：设了 `policy` 后，未命中任何 rule 或 rule 指向未知 profile → 跑内置 `locked`（零工具），而非回落全集。
- 解析器在 `config/policy.ts`，不在 `schema.ts`（`schema.ts` 只放接口 + 旧字段访问器）。`ProfileConfig`/`PolicyRule` 等接口仍定义在 `schema.ts`。

## 2. secret 解析五段管线（`config/secret-resolver.ts`）

`resolveAppSecret(cfg)` → `resolveSecretInput(secret, cfg.secrets, appId)`：

1. **plain / template**（`SecretInput` 是字符串）：`resolvePlainOrTemplate`——若匹配 `ENV_TEMPLATE_RE=^${VAR}$` 则读 `process.env[VAR]`，否则原样返回。
2. **env**（`SecretRef.source==='env'`）：`resolveEnvRef`——若 provider 有非空 `allowlist` 且 `ref.id` 不在其中则拒；读 `process.env[ref.id]`。
3. **file**：`resolveFileRef`——`provider.path ? join(path, id) : id` 读文件 trim。
4. **exec**：`resolveExecRef`——**self-bridge 短路**：若 `command` 是本 bridge 的 `secrets-getter` 脚本（或 args 以 `['secrets','get']` 结尾，遗留/手写形态），直接读 keystore（`getSecret(ref.id)`，回落 `secretKeyForApp(appId)`）；否则 `spawnExecProvider`。
5. **spawnExecProvider**：spawn `command args`（注入 `passEnv`/`env`），stdin 发 `{protocolVersion:1, provider, ids:[ref.id]}`，stdout 解析 `{values, errors}` 取 `values[ref.id]`；`noOutputTimeoutMs`（默认 5s）超时 SIGKILL，`maxOutputBytes`（默认 64KB）超限报错。

provider 级联：`lookupProvider` 按 `ref.provider ?? secrets.defaults?.[source] ?? 'default'` 查 `secrets.providers`。

## 3. AES keystore（`config/keystore.ts`）

本地 AES-256-GCM keystore，存 `paths.secretsFile`（`secrets.enc`）。常量：`KEY_LEN=32`、`IV_LEN=12`、`TAG_LEN=16`、`PBKDF2_ITER=100000`、`FILE_VERSION=1`。

- `StoreFile { version; entries: Record<id, Envelope> }`；`Envelope { iv; tag; data; ... }`（base64）。
- `loadOrCreateSalt()`：盐存 `paths.keystoreSaltFile`（`.keystore.salt`），缺则生成。盐**非密钥**——它只保证同机不同用户派生不同 key。
- `deriveKey()`：`pbkdf2Sync(seed, salt, 100000, 32, 'sha256')`，seed 由 host 信息派生。
- `encrypt`/`decrypt`（GCM + auth tag）。
- 公开：`getSecret(id)`、`setSecret(id, plaintext)`、`removeSecret(id)`、`listSecretIds()`（不泄露 secret）。

## 4. `config/store.ts`

- 配置文件支持 **JSON 或 YAML**：`resolveConfigPath(explicit?)` 选用——显式非默认路径（`--config foo.yaml`、测试临时文件）原样用；否则按 `config.json` → `config.yaml` → `config.yml` 取首个存在者，都不存在则回落 `config.json`（首次写入的默认）。`runStart` 启动时解析一次并贯穿 load/save/registry/controls。
- `loadConfig(path?)`：`resolveConfigPath` 后按扩展名解析（`.yaml`/`.yml` 走 `yaml.parse`，否则 `JSON.parse`），ENOENT/空文件返回 `{}`。
- `saveConfig(cfg, path?)`：**原子写**——写同目录临时文件（0600 权限）再 `rename`，避免半写窗口与宽权限明文残留；按解析出的文件扩展名序列化（YAML 写回会丢手写注释——`/config`、`/account` 等程序化改动会整篇重序列化）。
- `buildEncryptedAccountConfig(appId, tenant, preferences?)`：把 app secret 指向加密 keystore 的 exec-provider SecretRef，保留既有 `preferences`。用于 `/account` 改凭据与首启迁移。
- `ensureSecretsGetterWrapper()`：写 `~/.feishu-omp-bridge/secrets-getter` 薄包装脚本（用户所有、非符号链接），内部 `exec` 真正的 `node + bridge secrets get`——满足 lark-cli 的 `AssertSecurePath` 审计（不管 node 如何安装）。bridge 自身在 resolver 里见到这个 wrapper 路径就短路直读 keystore（见 §2）。

## 5. 安全模型（`README.md`）

- 不要提交 `config.json`、`secrets.enc`、日志、session 文件。
- App Secret 默认迁进加密 keystore，`config.json` 只存 SecretRef。
- keystore 防的是备份/误提交/日志泄漏中的明文暴露，**不是**同用户进程级强隔离。
- OMP 能跑本机工具 ≈ 把飞书消息授权给本地 Agent；生产建议配 `access.allowedUsers/allowedChats/admins`、`ompTools` 全局白名单、`guestPolicy` 访客沙箱、固定 cwd。群默认必须 @bot，`@全员` 不触发。

## 6. 是否后端通用

`store.ts`/`keystore.ts`/`paths.ts`/`secret-resolver.ts` 与 agent 后端无关，可整体复用——`dify-feishu-bridge` 仅改 `paths.ts` 的数据根、把 `schema.ts` 的 `omp*`/`codex*` 换成 `dify` 块、并把 `secret-resolver.ts` 从“解析 app secret”泛化为“解析任意 `SecretInput`”以便 `dify.apiKey` 复用同一管线（见 [dify 配置](../dify-feishu-bridge-design/04-config-session-and-guest.md)）。
