# Claude Code Discord Presence

## Overview

This repository contains a cross-platform Node.js service and npm CLI for Claude Code Desktop and
CLI Discord Rich Presence. Node.js 22.18 or newer and npm are required.

The entry point is `src/index.ts`; the public executable is `src/cli.ts`. The CLI installs user-level
Claude hooks and statusline scripts on first run, then starts the service with zero configuration.

## Code map

- `src/claude/` parses hooks, statusline input, plans, limits, transcripts, usage, and Desktop focus.
- `src/server/http-server.ts` exposes loopback-only telemetry routes with bounded request bodies.
- `src/discord/` builds and publishes Discord Rich Presence.
- `src/remote/tunnel-manager.ts` maintains opt-in reverse tunnels for validated SSH aliases.
- `src/appearance/` resolves Claude Desktop and system themes.
- `src/util/` contains bounded logging, process detection, and cross-platform autostart builders.
- `scripts/setup-claude.mjs` safely merges local user hooks and statusline settings.
- `scripts/setup-remote.mjs` and `scripts/install-remote.mjs` install the same files on explicit remotes.
- `tests/` contains the Vitest suite.

Runtime configuration is optional and read from environment variables or a CLI `--env` file.
Generated JavaScript belongs in `dist/`; never edit it directly. `.env`, logs, credentials,
transcripts, and generated package archives must not be committed.

## Commands

- `npm ci` — install the locked dependency graph.
- `npm test` — run the automated suite.
- `npm run typecheck` — check TypeScript without emitting files.
- `npm run build` — compile `src/` into `dist/`.
- `npm start` — build and run the service from source.
- `npm run setup` — install local Claude hooks and statusline.
- `npm pack` — build and create the publishable npm archive.

Run tests, type checking, build, and `npm pack --dry-run` after source, installer, or packaging changes.
