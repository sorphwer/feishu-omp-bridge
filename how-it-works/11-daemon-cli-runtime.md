# 11 · 守护进程与 CLI 运行时

> 源码基线：commit `33bcea3`（文档对应的源码 commit；详见 [README](./README.md)）。

> 覆盖范围：CLI 命令面（commander 接线）；预检（lark-cli 检测/安装/绑定、OMP 检查）；`ServiceAdapter` 接口与三平台实现（launchd/systemd/schtasks）、服务标识；`cli/commands/*`；进程注册表；日志器；进程生命周期/信号 + 未捕获异常网。
>
> 源文件：`src/cli/index.ts`、`src/cli/preflight.ts`、`src/cli/commands/{start,service,ps,secrets,migrate}.ts`、`src/daemon/{service-adapter,launchd,systemd,schtasks,paths}.ts`、`src/runtime/registry.ts`、`src/core/logger.ts`。

相关篇：[总览与架构](./01-overview-and-architecture.md)（启动序列）、[配置与密钥](./08-config-and-secrets.md)（secrets 子命令）、[聊天命令](./10-commands.md)（`/ps`/`/exit`/`/doctor`）。

## 1. CLI 命令面（`cli/index.ts`）

commander 程序 `feishu-omp-bridge`，默认子命令 `run`（`argv.length>2 ? argv : [...argv, 'run']`）：

```mermaid
flowchart TD
  CLI["feishu-omp-bridge (无参数时默认 run)"]
  CLI --> PROC["进程级"]
  CLI --> SVC["服务级 (OS 守护)"]
  CLI --> SEC["secrets 组"]
  PROC --> RUN["run -c/--config · --skip-check-lark-cli<br/>→ runStart (前台)"]
  PROC --> PS["ps → runPs"]
  PROC --> KILL["kill &lt;target&gt; → runKillCli<br/>(SIGTERM → 2s → SIGKILL)"]
  SVC --> ST["start --skip-check-lark-cli → runServiceStart"]
  SVC --> SP["stop → runServiceStop (停 + 禁自启)"]
  SVC --> RS["restart → runServiceRestart"]
  SVC --> SS2["status → runServiceStatus"]
  SVC --> UN["unregister → runServiceUnregister"]
  SEC --> SG["get (exec-provider, stdin/stdout JSON)"]
  SEC --> SSET["set --app-id (隐藏输入)"]
  SEC --> SL["list"]
  SEC --> SR["remove --app-id"]
```

进程级：
- `run`（默认）：`-c, --config <path>`、`--skip-check-lark-cli` → `runStart`（见 [01](./01-overview-and-architecture.md)）。
- `ps` → `runPs`（列本机进程）。
- `kill <target>` → `runKillCli`（按短 id / 序号杀，SIGTERM 后 2s SIGKILL）。

服务级（OS 守护）：
- `start`（`--skip-check-lark-cli`） → `runServiceStart`（安装并启动 daemon）。
- `stop` → `runServiceStop`（停且禁自启）。
- `restart` → `runServiceRestart`（服务文件不存在则报错让先 `start`；没在运行则走 `start` 路径）。
- `status` → `runServiceStatus`（pid、上次退出、日志路径）。
- `unregister` → `runServiceUnregister`（停 + 禁自启 + 删服务文件）。

`secrets` 子命令组：`get`（exec-provider 协议，stdin JSON → stdout JSON，供 lark-cli `config bind --source lark-channel`）、`set --app-id`、`list`、`remove --app-id`（见 [08](./08-config-and-secrets.md)、`cli/commands/secrets.ts`）。

> `runMigrate`（`cli/commands/migrate.ts`）在 `cli/index.ts` 被 import，但当前未注册为 commander 子命令——它是一次性遗留迁移器（`~/.config/feishu-codex-bridge` + `~/.cache/feishu-codex-bridge` → `~/.feishu-omp-bridge`，以及 `{app}` → `{accounts:{app}}` 配置形状），幂等，可在需要时手动调用。

## 2. 预检（`cli/preflight.ts`）

`preFlightChecks({ skipCheckLarkCli })` → `checkLarkCli`：检测 `lark-cli` 是否安装（`isLarkCliInstalled`，`lark-cli --version` 退出码），未装则提示并尝试两步（各带 clack spinner）：`npm install -g @larksuite/cli` + `lark-cli config bind --source lark-channel --identity bot-only`（`runCapture` 捕获子进程输出保持 spinner 干净，`INSTALL_TIMEOUT_MS=5min`、`BIND_TIMEOUT_MS=30s`），失败打印手动安装提示但不致命。**非 TTY**（daemon / launchd / nohup / CI）不自动安装，只打印手动提示后继续启动——因此服务级 `start` 会在写服务文件**之前**先跑同一套 preflight（此时用户在 TTY，可交互装；daemon 自己被 OS 拉起时的 preflight 是非 TTY，会静默跳过安装）。`--skip-check-lark-cli` 跳过整步。OMP 可用性检查不在 preflight，而在 `runStart` 里 `agent.isAvailable()`（缺失即 `process.exit(1)`，见 [01](./01-overview-and-architecture.md)）。

## 3. 服务适配器（`daemon/`）

`ServiceAdapter` 接口（`daemon/service-adapter.ts`）：`platformName`、`fileExists()`、`isRunning()`、`servicePath()`、`install()`、`start()`、`stop()`、`stopAndDisableAutostart()`、`restart()`、`waitUntilStopped(timeoutMs?)`、`deleteFile()`、`describeStatus()`、`parseStatus(text)`（提取 pid/lastExit）。返回值可同步或异步（`ServiceResultLike`）。`getServiceAdapter()` 按平台返回 `makeLaunchdAdapter`/`makeSystemdAdapter`/`makeSchtasksAdapter`，不支持的 OS 返回 null。

```mermaid
flowchart TD
  GET["getServiceAdapter()"] --> OS{"平台?"}
  OS -->|macOS| LD["launchd (plist, KeepAlive=true)"]
  OS -->|Linux| SD["systemd --user (Restart=always)"]
  OS -->|Windows| ST["schtasks (ONLOGON .cmd)"]
  OS -->|其它| NULL["null (不支持)"]
```

服务标识（`daemon/paths.ts`）：

| 项 | 值 |
| --- | --- |
| `SERVICE_NAME` | `feishu-omp-bridge.bot` |
| macOS `LAUNCH_AGENT_LABEL` | `ai.feishu-omp-bridge.bot`（plist 在 `~/Library/LaunchAgents/`） |
| Linux `SYSTEMD_UNIT_NAME` | `feishu-omp-bridge.bot.service`（unit 在 `$XDG_CONFIG_HOME/systemd/user/` 或 `~/.config/systemd/user/`） |
| Windows `WINDOWS_TASK_NAME` | `FeishuOmpBridge.Bot`（`.cmd` 包装在 `~/.feishu-omp-bridge/daemon-launcher.cmd`） |

daemon 日志：`daemonLogDir()`=`~/.feishu-omp-bridge/logs/`，`daemonStdoutPath()`/`daemonStderrPath()`（`daemon-stdout.log`/`daemon-stderr.log`，与结构化日志同目录、`daemon-` 前缀区分）。

三平台实现：
- `launchd.ts`：`buildPlist`/`writePlist`、`bootstrap`/`bootout`/`kickstart -k`（重启）、`isLoaded`（`launchctl print`）、`describeService`、`deletePlist`、`waitUntilUnloaded`。`KeepAlive=true` 等价于 systemd `Restart=always`。
- `systemd.ts`：`buildUnit`/`writeUnit`、`daemonReload`、`enableAndStart`（`enable --now`）、`stop`、`disableAndStop`、`restart`、`isActive`（`is-active`）、`describeService`、`deleteUnit`、`waitUntilInactive`。Unit 含 `Restart=always`+`RestartSec=5`。
- `schtasks.ts`：`buildLauncherCmd`/`writeLauncherCmd`、`installTask`（触发 ONLOGON，`/Create /F`）、`runTask`/`endTask`/`disableTask`/`enableTask`/`endAndDisable`/`restartTask`（end→wait→run）、`isTaskRegistered`/`isTaskRunning`（解析 `/Query /V /FO LIST`）、`describeTask`、`waitUntilStopped`、`deleteTask`。

`cli/commands/service.ts`：`requireAdapter`（无适配器友好退出）、`ensureBridgeConfigured`（`loadConfig` + `isComplete`，未配置则提示先跑 `run` 扫码向导并退出）、`waitForServiceConnect`/`reportConnectAfter`（start/restart 前快照同 appId 的 `beforePids`，下发 OS 动作后每 500ms 轮询 `processes.json`，最多 30s，找 appId 匹配、pid 不在 `beforePids`、且 `botName` 已填的新条目——`botName` 只在 WS 握手成功后回填，见 §6，故看到即真在线；超时则警告并给出 daemon 日志路径）、`runServiceStart/Stop/Restart/Status/Unregister`、`formatServiceStderr`/`printServiceFailure`（中文化常见失败，如“旧实例还在收尾”）。

`runServiceStart` 的完整生命周期（`install()` 总是重写服务文件，吸收当前 `process.execPath` 与 `PATH`，防运行时版本切换后失效）：

```mermaid
sequenceDiagram
  participant U as 用户 shell
  participant S as runServiceStart
  participant A as ServiceAdapter
  participant R as processes.json 注册表
  participant D as daemon 进程 (run)
  U->>S: feishu-omp-bridge start
  S->>S: requireAdapter + ensureBridgeConfigured
  S->>S: preFlightChecks (TTY,可交互装 lark-cli)
  S->>A: install() 重写 plist/unit/.cmd + reload
  alt 旧实例还在运行
    S->>A: stop() + waitUntilStopped()<br/>(没停干净则提示 unregister 后 exit 1)
  end
  S->>R: 快照 beforePids (同 appId 存活 pid)
  S->>A: start()
  A->>D: OS 拉起 daemon (非 TTY 的 run)
  D->>R: register(...) 写入条目
  D->>R: WS 握手成功后 updateEntry 补 botName
  loop 每 500ms,最多 30s
    S->>R: readAndPrune() 找新条目<br/>(appId 匹配 · pid 不在 beforePids · botName 已填)
  end
  S-->>U: ✓ 已启动 bot ... 进程 id<br/>(超时: ⚠ + daemon 日志路径)
```

## 4. 进程注册表（`runtime/registry.ts`）

`processes.json`（`paths.processesFile`）记录运行中的 bridge 进程，用于 `/ps`、`/exit`、同应用冲突检测。

- `ProcessRole = 'standalone'|'front'|'worker'`（仅前两者开飞书 WS 长连接；worker 共享应用但不开，故不算竞争连接）。
- `ProcessEntry`（id/pid/appId/tenant/configPath/version/role/botName?/startedAt 等）。
- `isAlive(pid)`（`kill(pid,0)`）、`readAndPrune(path)`（读并丢死条目，不持久化，供只读视图）、`register(args)`（原子 prune+add，返回带短 id 的 entry）、`unregister`/`unregisterSync`、`updateEntry(id, patch)`（`/account` 后更新 appId/tenant/botName）、`generateShortId`、`sameAppOthers(appId, excludePid)`（同应用其它存活进程，冲突检测用）、`resolveTarget(target)`（短 id 或 1-based 序号 → entry）、`cleanupTmpFiles`。`writeAtomic`/`writeAtomicSync` 原子写。

`cli/commands/ps.ts`：`runPs`（定宽表）、`runKillCli`（SIGTERM→2s→SIGKILL）。

## 5. 日志器（`core/logger.ts`）

结构化日志 + 紧凑 stdout。

- 每日 `YYYY-MM-DD.log` 写在 `logsDir()`（`~/.feishu-omp-bridge/logs/`），保留 `LOG_RETENTION_DAYS`（默认 7，`LARK_CHANNEL_LOG_DAYS` 覆盖）。
- `log` 导出（`info`/`warn`/`error`/`fail`）：`emit(level, phase, event, fields)` 写 JSON 行；`RESERVED_KEYS` 防 caller 覆盖内部字段；stdout 只放 `STDOUT_INFO_ALLOWLIST` 里的 info 事件（其余降噪）。
- `withTrace(ctx, fn)`：`AsyncLocalStorage` 让 fn 内（跨 await）所有 `log.*` 自动带 `traceId`/`chatId`/`msgId`；`newTraceId()`。
- `sanitizeLogsForDoctor(logs)`：脱敏标识/凭据材料（`/doctor` 把日志喂模型前用，见 [10](./10-commands.md)）。
- `readRecentLogs({maxBytes})`：读今天（必要时含昨天）日志尾（`readTail`）。
- `gcOldLogs()`：删超出保留窗口的日志文件（启动时调，返回删除数）。

## 6. 进程生命周期与信号

`runStart`（`cli/commands/start.ts`，见 [01](./01-overview-and-architecture.md)）：
- 顶部 `process.on('unhandledRejection')` / `process.on('uncaughtException')` 只记 `log.fail('process', ...)` 不退出——丢一条回复也比崩掉强。
- `dns.setDefaultResultOrder('ipv4first')` 规避 IPv6 坏路由。
- 启动即 `register({appId, tenant, configPath, version, role})` 写注册表；`startBridge` 完成（WS 握手成功）后 `updateEntry(entry.id, { botName })` 回填 bot 显示名——`reportConnectAfter`（§3）和同应用冲突提示都靠它判断“真在线”。
- `stop(sig)`：幂等，断开 bridge、`unregisterSync(entry.id)`、`process.exit(0)`。注册到 `SIGINT`/`SIGTERM`。
- `process.on('exit')`：`unregisterSync` + `cleanupTmpFiles`（兜底，防绕过 stop 的退出留下陈旧条目）。
- `controls.restart()`：**连后断**——`restarting` 标志防重入；先 `loadConfig(configPath)` 重读磁盘配置（`isComplete` 不过即抛错），再 `startBridge` 新 bridge，成功才断旧 bridge（新 bridge 起不来时抛错保留旧 bridge 及其 keepalive，下一 keepalive tick ~15s 后可重试）；换毕 `controls.cfg = next` 并 `updateEntry(entry.id, {appId, tenant, configPath, botName})` 同步注册表（`/ps` 立刻反映新 app）。`/account`、`/reconnect`、keepalive 强制重连都走它。

```mermaid
flowchart LR
  REQ["controls.restart()<br/>(/account · /reconnect · keepalive)"] --> CFG["loadConfig(configPath) 重读<br/>isComplete 校验"]
  CFG --> NEW["startBridge 新 bridge"]
  NEW --> OK{"起来了?"}
  OK -->|"是"| KILL["断开旧 bridge (连后断)"]
  KILL --> SYNC["controls.cfg = next<br/>updateEntry 同步注册表 (appId/tenant/botName)"]
  OK -->|"否"| KEEP["抛错: 保留旧 bridge + keepalive<br/>下一 tick (~15s) 重试"]
```


## 7. 是否后端通用

整个 daemon/CLI/registry/logger 层与 agent 后端无关，可整体复用——`dify-feishu-bridge` 仅重命名服务标识（`daemon/paths.ts` → `dify-feishu-bridge.bot` / `ai.dify-feishu-bridge.bot` / `DifyFeishuBridge.Bot`）、数据根（`config/paths.ts`）、`package.json` name/bin，并把 `preflight.ts` 的 OMP 检查换成可选的 Dify 连通性探测。详见 [dify 迁移与验证](../dify-feishu-bridge-design/06-migration-and-verification.md)。
