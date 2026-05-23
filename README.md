# feishu-codex-bridge

A lightweight bot that bridges Feishu / Lark messenger with the local Codex CLI. It keeps the familiar Feishu chat-bridge experience, but the agent that actually runs is `codex exec --json`.

## What it does

- Forwards Feishu / Lark messages to the local Codex CLI, either by direct message or by `@bot` in a group.
- Streams Codex text, command execution, and tool output into Lark cards.
- Stores one Codex thread id per chat / topic and automatically resumes with `codex exec resume --json <thread_id>`.
- Keeps the familiar bridge commands: `/new`, `/cd`, `/ws`, `/status`, `/config`, `/stop`, and more.
- Downloads images / files to local paths; image paths are also passed to Codex with `--image`.
- Lets Codex use local tools that are already available on the machine, such as `lark-cli`, `git`, and project test commands.

## Prerequisites

- Node.js >= 20
- pnpm for local development / source builds
- Codex CLI installed and logged in: `codex login`
- A Feishu / Lark PersonalAgent app. The first-run wizard helps configure it.

## Install / build

Run from source:

```bash
pnpm install
pnpm build
node ./dist/cli.js --help
```

After publishing or linking the package globally:

```bash
feishu-codex-bridge
```

Running without a subcommand is now equivalent to `feishu-codex-bridge run`.

## First run

```bash
feishu-codex-bridge
```

The first run checks configuration and guides you through:

1. Choose Feishu or Lark tenant.
2. Enter the PersonalAgent App ID / App Secret.
3. Scan or complete the `lark-cli` binding flow when prompted.
4. Config is written to `~/.feishu-codex-bridge/config.json`; secrets are encrypted in the local keystore.

## CLI commands

### Foreground process

```bash
feishu-codex-bridge run [-c <config>]     Run the bot in the foreground
feishu-codex-bridge ps                    List running bridge processes on this machine
feishu-codex-bridge kill <id|#>           Kill a bridge process (SIGTERM, SIGKILL after 2s)
feishu-codex-bridge secrets <subcommand>  Manage the encrypted local secret keystore
feishu-codex-bridge --help                List all commands
```

### Background daemon

> Service-level commands should use a globally installed package or another stable executable path. The daemon's launchd plist / systemd unit / Windows task records the CLI path; do not register a daemon through a temporary `npx` cache path.

```bash
feishu-codex-bridge start                 Install if needed and start the daemon
feishu-codex-bridge stop                  Stop the daemon and disable autostart
feishu-codex-bridge restart               Restart the daemon
feishu-codex-bridge status                Show daemon status, pid, logs, and last exit
feishu-codex-bridge unregister            Remove service registration and stop
```

Daemon backends:

- macOS: `launchd` user agent at `~/Library/LaunchAgents/ai.feishu-codex-bridge.bot.plist`
- Linux: `systemd` user unit at `~/.config/systemd/user/feishu-codex-bridge.bot.service`
- Windows: Task Scheduler task `FeishuCodexBridge.Bot`

## Chat commands

| Command | Description |
| --- | --- |
| `/new`, `/reset` | Clear the current chat / topic Codex thread; the next message starts fresh. |
| `/new chat [name]` | Create a new group, invite you, and inherit the current cwd. |
| `/cd <path>` | Change cwd for the current chat / topic and reset the session. Supports `~/xxx`. |
| `/ws list` | Show named workspaces. |
| `/ws save <name>` | Save the current cwd as a named workspace. |
| `/ws use <name>` | Switch to a named workspace and reset the session. |
| `/ws remove <name>` | Delete a named workspace. |
| `/account` | Show current app information. |
| `/account change` | Change appId / secret and reconnect. |
| `/config` | Adjust preferences such as reply mode, tool visibility, concurrency, and idle timeout. |
| `/status` | Show current scope, cwd, session, and agent. |
| `/stop` | Stop the currently running Codex task. |
| `/timeout [N\|off\|default]` | Set, disable, or reset the idle watchdog for the current session. |
| `/ps` | List all local bot processes and highlight the one replying now. |
| `/exit <id\|#>` | Stop a selected bot process. |
| `/reconnect` | Force a WebSocket reconnect. |
| `/doctor [description]` | Ask Codex to diagnose recent logs plus your description. |
| `/help` | Show the help card. |

Any other normal message is forwarded to Codex. Groups require `@bot` by default; direct messages do not.

## Data directory

| Path | Purpose |
| --- | --- |
| `~/.feishu-codex-bridge/config.json` | App credential references and preferences. |
| `~/.feishu-codex-bridge/secrets.enc` | Encrypted local secret keystore. |
| `~/.feishu-codex-bridge/sessions.json` | Codex thread id, cwd, and optional timeout override per chat / topic. |
| `~/.feishu-codex-bridge/workspaces.json` | Named workspace map. |
| `~/.feishu-codex-bridge/processes.json` | Registry of running bridge processes. |
| `~/.feishu-codex-bridge/media/` | Downloaded image / file cache. |
| `~/.feishu-codex-bridge/logs/` | Structured bridge logs and daemon stdout / stderr. |

## Codex preferences

Set these under `preferences` in `config.json`:

```json
{
  "preferences": {
    "codexBinary": "codex",
    "codexModel": "gpt-5.1",
    "messageReply": "markdown",
    "showToolCalls": true,
    "maxConcurrentRuns": 10,
    "runIdleTimeoutMinutes": 0,
    "agentStopGraceMs": 5000
  }
}
```

- `codexBinary`: Codex executable name or absolute path. Default: `codex`.
- `codexModel`: model passed to `codex exec -m`; leave empty to let Codex config decide.
- `messageReply`: `card`, `markdown`, or `text`.
- `showToolCalls`: whether command execution details are shown in cards / Markdown.

## Difference from codex-remote-feishu

This project is a lightweight chat bridge for sending Feishu messages directly to a local Codex CLI. If you need full remote takeover, VS Code follow mode, daemon/app-server protocol, or richer background thread management, use `codex-remote-feishu`.

## Troubleshooting

- `run` cannot find `codex`: confirm `codex --version` works and run `codex login`.
- Codex did not resume the previous conversation: send `/status` to inspect cwd and session; a cwd change makes the bridge start a new session.
- Group messages get no response: make sure the message mentions `@bot`, or change the mention policy with `/config`.
- A card appears stuck: use `/stop`, or enable an idle watchdog for the current session with `/timeout 10`.
- Feishu API tools are unavailable: install and bind `lark-cli` as prompted during startup.
