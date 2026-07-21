# Claude Code Discord Presence

[![npm version](https://img.shields.io/npm/v/claude-code-discord-presence?logo=npm)](https://www.npmjs.com/package/claude-code-discord-presence)
[![CI](https://github.com/dayfinggg/claude-code-discord-presence/actions/workflows/ci.yml/badge.svg)](https://github.com/dayfinggg/claude-code-discord-presence/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22.18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Cross-platform Discord Rich Presence for Claude Code Desktop and Claude Code CLI. Show the active
model, effort, usage limits, reset countdowns, tools, agents, token usage, cost, context, plan mode,
Fast mode, and secure remote SSH sessions on Windows, macOS, and Linux.

![Claude Code Discord Rich Presence with plan limits, model, effort, activity status, usage statistics, and session timer](https://raw.githubusercontent.com/dayfinggg/claude-code-discord-presence/main/assets/claude-code-presence-cover.png)

## Quick start — no manual hook setup

You only need Node.js 22.18 or newer, Claude Code, and Discord Desktop. The first command safely
installs the required Claude Code hooks and statusline, then starts Rich Presence:

```bash
npx claude-code-discord-presence
```

For a persistent command:

```bash
npm install --global claude-code-discord-presence
claude-code-presence
```

No Discord application, `.env` file, Bun, `jq`, `curl`, or platform-specific shell script is
required. Existing unrelated Claude settings and hooks are preserved.

## What it shows

| Discord field | Live data |
| --- | --- |
| Details | Plan and authoritative 5-hour/7-day allowance left with reset countdowns |
| State | Model, effort, Fast mode, current tool/action, Plan mode, agents, notifications |
| Timer | Current Claude Code session duration |
| Large-image tooltip | Input, cache read/write, output, cost, and context usage |
| Small-image tooltip | Day, week, month, and all-time token and cost totals |

The account usage endpoint is preferred over placeholder statusline zeroes. This prevents the false
`100% left` display that some Claude clients emit while keeping statusline data as an offline fallback.

## Hooks and statusline

The installer copies self-contained Node.js scripts to `~/.claude/discord-presence/` and updates the
user-level `settings.json` used by Claude Code CLI and Desktop.

- Command hooks cover `SessionStart`, prompts, tool use and failures, agents, notifications, stop,
  and session end.
- `SessionStart` uses an official command hook rather than an unsupported HTTP hook.
- The statusline displays the model, effort, Fast mode, and available usage while forwarding the
  same structured payload to Rich Presence.
- Hook and statusline scripts never create their own logs and silently tolerate a stopped service.
- Existing settings are backed up under `~/.claude/backups/claude-code-presence/`; only five backups
  are retained.

Run the installer explicitly at any time with `claude-code-presence setup`.

## Desktop, CLI, and platforms

| Platform | Claude Code Desktop | Claude Code CLI | Per-user autostart |
| --- | ---: | ---: | ---: |
| Windows | Yes | Yes | Registry launcher with a bounded supervisor log |
| macOS | Yes | Yes | LaunchAgent |
| Linux | Where available | Yes | systemd user service |

Windows detection supports Microsoft Store, native Desktop, and native CLI processes. macOS and
Linux combine Claude's session PID files with native `ps` scanning, so either Desktop or CLI keeps
the correct activity alive. Desktop focus files select ordinary chats as well as project sessions.

## Autostart

```bash
claude-code-presence autostart
```

The command ensures hooks are installed before registering startup. Remove it with:

```bash
claude-code-presence autostart:remove
```

`Ctrl+C` stops only the foreground instance in the current terminal. The removal command also
gracefully stops an active background instance so Discord activity is cleared before exit.

## Optional configuration

Defaults work without configuration. Pass options directly:

```bash
claude-code-presence --log-level debug --usage-poll-interval 120
claude-code-presence --claude-config-dir ~/.custom-claude
```

Or copy `.env.example`, edit it, and run `claude-code-presence --env /path/to/.env`.

| CLI option | Environment variable | Purpose |
| --- | --- | --- |
| `--application-id` | `CLAUDE_DISCORD_APPLICATION_ID` | Use a different Discord application |
| `--port` | `PORT` | Local loopback hook port; default `41724` |
| `--claude-config-dir` | `CLAUDE_CONFIG_DIR` | Override Claude's user config directory |
| `--desktop-sessions-dir` | `CLAUDE_DESKTOP_SESSIONS_DIR` | Override Desktop focus files, or `off` |
| `--remote-hosts` | `CLAUDE_REMOTE_HOSTS` | Comma-separated SSH config aliases |
| `--remote-port` | `CLAUDE_REMOTE_PORT` | Remote loopback forwarding port |
| `--usage-poll-interval` | `USAGE_POLL_INTERVAL_S` | Account limit refresh interval |
| `--log-level` | `RPC_LOG_LEVEL` | `debug`, `info`, `warn`, `error`, or `silent` |
| `--log-max-bytes` | `RPC_LOG_MAX_BYTES` | Maximum size of the active log; default 1 MiB |

Set `USAGE_TOKEN_REFRESH=on` only if you explicitly want the service to refresh and save Claude's
OAuth token. The safe default is read-only: Claude Code remains responsible for its credentials.
The repository `.env` is ignored and never published to GitHub or npm.

## Secure remote Claude Code sessions

Use SSH config aliases; the project never contains a hostname, address, username, port, or key.
First install the same Node hooks and statusline on explicitly selected hosts:

```bash
claude-code-presence remote:setup --remote-hosts work-box,dev-box
```

Then start with the same allowlist:

```bash
claude-code-presence --remote-hosts work-box,dev-box
```

The service maintains reverse tunnels from remote `127.0.0.1` to local `127.0.0.1`. Aliases that
look like SSH options, user/address targets, whitespace, or shell syntax are rejected. SSH runs with
`shell: false`, batch mode, connection timeouts, bounded reconnect backoff, and loopback-only binds.

## Logging, privacy, and safety

The receiver binds only to `127.0.0.1`, accepts only health, hook, and statusline routes, caps JSON
bodies at 512 KiB, and has short request timeouts. Hooks do not control Claude or execute received
commands; they provide telemetry to the in-memory presence store.

The default log level is `warn`. Normal statusline invocations, hooks, polling, and Discord updates
are not logged. The active log and one archive are each limited to 1 MiB by default. Access tokens,
hook bodies, transcripts, and tool inputs are never written to logs.

## Build from source

```bash
git clone https://github.com/dayfinggg/claude-code-discord-presence.git
cd claude-code-discord-presence
npm ci
npm test
npm run typecheck
npm run build
npm start
```

## Discord assets

The exact light, dark, fallback, and usage images used by the default Discord application are in
[`assets/`](assets). Use the matching keys from `.env.example` when configuring another application.

## License and attribution

[MIT](LICENSE). This community project is not affiliated with or endorsed by Anthropic or Discord.
Anthropic, Claude, Claude Code, and Discord are trademarks of their respective owners.
