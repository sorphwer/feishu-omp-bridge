# feishu-omp-bridge

A lightweight bot that bridges Feishu / Lark messenger with the local Oh My Pi CLI. Feishu messages are delivered to `omp --mode rpc`, streamed back as cards or Markdown, and resumed per chat / topic through an isolated OMP session directory.

## What it does

- Forwards Feishu / Lark direct messages, group `@bot` messages, topic messages, and cloud-doc comment mentions to local OMP.
- Streams OMP text, thinking, tool calls, tool updates, and tool results into Feishu cards or Markdown.
- Maps OMP native UI requests (`confirm`, `select`, `input`, `editor`) to Feishu interactive cards and sends the chosen response back to the live RPC run.
- Renders OMP extension `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`, and `open_url` events in the Feishu run output.
- Registers Feishu-native OMP host tools (`feishu_current_context`, `feishu_send_message`, `feishu_reply_message`, `feishu_get_message`) so OMP can use Feishu without shelling out to `lark-cli`.
- Registers the `feishu://` host URI scheme for OMP reads such as `feishu://current/context` and `feishu://message/<message_id>`.
- Routes messages sent while OMP is still running into the live run as OMP `follow_up`; prefix with `!` to send a steering message.
- Stores one OMP session id per chat / topic and resumes with `omp --mode rpc --resume <session_id>`.
- Keeps bridge commands: `/new`, `/cd`, `/ws`, `/status`, `/config`, `/stop`, `/timeout`, `/ps`, `/exit`, `/reconnect`, and `/doctor`.
- Downloads images / files to local paths; images are converted to OMP RPC image payloads.
- Lets OMP use local tools already available on the machine, such as `lark-cli`, `git`, and project test commands.

## Prerequisites

- Node.js 20+
- pnpm for local development / source builds
- Oh My Pi CLI installed and configured: run `omp` once and verify `omp --mode rpc` works.
- A Feishu / Lark PersonalAgent app. The first-run wizard helps configure it.

## Install / build

```bash
pnpm install
pnpm build
```

For local development:

```bash
pnpm dev
```

If installed as a package, the CLI binary is:

```bash
feishu-omp-bridge
```

Running without a subcommand is equivalent to `feishu-omp-bridge run`.

## First run

```bash
feishu-omp-bridge
```

The first run checks configuration and guides you through:

1. Feishu or Lark tenant selection.
2. PersonalAgent App ID / App Secret.
3. Optional `lark-cli` installation and binding for Feishu-side API tools.
4. Config written to `~/.feishu-omp-bridge/config.json`; secrets encrypted in the local keystore.

## CLI commands

```bash
feishu-omp-bridge run [-c <config>]     Run the bot in the foreground
feishu-omp-bridge ps                    List running bridge processes on this machine
feishu-omp-bridge kill <id|#>           Kill a bridge process
feishu-omp-bridge secrets <subcommand>  Manage the encrypted local secret keystore
feishu-omp-bridge --help                List all commands
```

### Background daemon

```bash
feishu-omp-bridge start                 Install if needed and start the daemon
feishu-omp-bridge stop                  Stop the daemon and disable autostart
feishu-omp-bridge restart               Restart the daemon
feishu-omp-bridge status                Show daemon status and log paths
feishu-omp-bridge unregister            Remove daemon registration files
```

Daemon backends:

- macOS: launchd user agent `ai.feishu-omp-bridge.bot`
- Linux: systemd user unit `feishu-omp-bridge.bot.service`
- Windows: Task Scheduler task `FeishuOmpBridge.Bot`

## Chat commands

| Command | Effect |
| --- | --- |
| `/new`, `/reset` | Clear the current chat / topic OMP session; the next message starts fresh. |
| `/new chat [name]` | Create a new group, invite you, and inherit the current cwd. |
| `/cd <path>` | Change cwd for the current chat / topic and reset the session. Supports `~/xxx`. |
| `/ws list` | Show named workspaces. |
| `/ws add <name> <path>` | Save a named workspace. |
| `/ws use <name>` | Switch cwd to a named workspace and reset the session. |
| `/config` | Open the preference card. |
| `/account` | Replace the bot app credentials and reconnect. |
| `/status` | Show current scope, cwd, session, and agent. |
| `/stop` | Stop the currently running OMP task. |
| `/timeout [N|off|default]` | Set, disable, or reset the idle watchdog for the current session. |
| `/ps` | List all local bot processes and highlight the one replying now. |
| `/exit <id|#>` | Stop a selected bot process. |
| `/reconnect` | Force a WebSocket reconnect. |
| `/doctor [description]` | Ask OMP to diagnose recent logs plus your description. |
| `/help` | Show the help card. |

Any other normal message is forwarded to OMP. Groups require `@bot` by default; direct messages do not.

## Data directory

| Path | Purpose |
| --- | --- |
| `~/.feishu-omp-bridge/config.json` | App credentials, secret refs, and preferences. |
| `~/.feishu-omp-bridge/secrets.enc` | Encrypted local secret keystore. |
| `~/.feishu-omp-bridge/sessions.json` | OMP session id, cwd, and optional timeout override per chat / topic. |
| `~/.feishu-omp-bridge/omp-sessions/` | Bridge-owned OMP JSONL session files. |
| `~/.feishu-omp-bridge/workspaces.json` | Named workspace map. |
| `~/.feishu-omp-bridge/processes.json` | Registry of running bridge processes. |
| `~/.feishu-omp-bridge/media/` | Downloaded image / file cache. |
| `~/.feishu-omp-bridge/logs/` | Structured bridge logs and daemon stdout/stderr logs. |

## OMP preferences

Set these under `preferences` in `config.json`:

```json
{
  "preferences": {
    "ompBinary": "omp",
    "ompModel": "gpt-5.5",
    "ompThinking": "xhigh",
    "ompSessionDir": "~/.feishu-omp-bridge/omp-sessions",
    "ompTools": "read,bash,edit,write",
    "messageReply": "markdown",
    "showToolCalls": true,
    "maxConcurrentRuns": 10,
    "runIdleTimeoutMinutes": 0,
    "requireMentionInGroup": true
  }
}
```

- `ompBinary`: OMP executable name or absolute path. Default: `omp`.
- `ompModel`: model passed to `omp --model`; leave empty to let OMP config decide.
- `ompThinking`: thinking level passed to `omp --thinking`; leave empty to let OMP config decide.
- `ompSessionDir`: OMP session storage used by this bridge. Default: `~/.feishu-omp-bridge/omp-sessions`.
- `ompTools`: comma-separated tool allowlist passed to `omp --tools`; leave empty to enable OMP defaults.
- `messageReply`: `card`, `markdown`, or `text`.
- `showToolCalls`: whether tool execution details are shown in cards / Markdown.

## Feishu-native OMP host surface

Every OMP run started by the bridge registers these host tools:

| Tool | Purpose |
| --- | --- |
| `feishu_current_context` | Return the current scope, chat, topic, triggering message, and cwd. |
| `feishu_send_message` | Send markdown to the current chat or an explicit `chatId`. |
| `feishu_reply_message` | Reply with markdown to the triggering message or an explicit `messageId`. |
| `feishu_get_message` | Fetch and normalize a Feishu message by `messageId`. |

The bridge also registers `feishu://` as a read-only host URI scheme:

- `feishu://current/context`
- `feishu://message/<message_id>`

Messages posted to the same chat/topic while a run is active are sent to OMP as `follow_up` instead of waiting for a second run. Start a message with `!` to send it as `steer`.

Legacy `codexBinary` and `codexModel` are still read as fallbacks when the OMP fields are absent, so older config files can boot and be migrated manually.

## Troubleshooting

- `run` cannot find `omp`: confirm `omp --version` works and run `omp` once to finish model/auth setup.
- OMP did not resume the previous conversation: send `/status` to inspect cwd and session; a cwd change makes the bridge start a new session.
- Group messages get no response: make sure the message mentions `@bot`, or change the mention policy with `/config`.
- A card appears stuck: use `/stop`, or enable an idle watchdog for the current session with `/timeout 10`.
- OMP is waiting for a choice/input: answer the separate "OMP 交互" card. The idle watchdog pauses while that UI request is pending.
- Feishu API tools are unavailable: install and bind `lark-cli` as prompted during startup.
