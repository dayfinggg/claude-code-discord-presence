#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(projectDir, "package.json"), "utf8")) as {
  version: string;
};
const flagEnvironment: Record<string, string> = {
  "--application-id": "CLAUDE_DISCORD_APPLICATION_ID",
  "--port": "PORT",
  "--claude-config-dir": "CLAUDE_CONFIG_DIR",
  "--desktop-sessions-dir": "CLAUDE_DESKTOP_SESSIONS_DIR",
  "--remote-hosts": "CLAUDE_REMOTE_HOSTS",
  "--remote-port": "CLAUDE_REMOTE_PORT",
  "--usage-poll-interval": "USAGE_POLL_INTERVAL_S",
  "--log-level": "RPC_LOG_LEVEL",
  "--log-max-bytes": "RPC_LOG_MAX_BYTES",
};

function help(): void {
  console.log(`Claude Code Discord Presence ${packageJson.version}

Usage:
  claude-code-presence [start] [options]
  claude-code-presence setup [options]
  claude-code-presence remote:setup [options]
  claude-code-presence autostart [options]
  claude-code-presence autostart:remove

Options:
  --env <file>                 Load an optional environment file
  --application-id <id>        Override the shared Discord application
  --port <port>                Local hook server port (default: 41724)
  --claude-config-dir <path>   Override Claude's configuration directory
  --desktop-sessions-dir <p>   Override Desktop session discovery, or off
  --remote-hosts <aliases>     Comma-separated SSH config aliases
  --remote-port <port>         Remote loopback tunnel port
  --usage-poll-interval <sec>  Account usage refresh interval
  --log-level <level>          debug, info, warn, error, or silent
  --log-max-bytes <bytes>      Maximum bytes per log file
  -h, --help                   Show help
  -v, --version                Show version`);
}

const args = process.argv.slice(2);
let command = "start";
if (args[0] && !args[0].startsWith("-")) command = args.shift()!;
let envFile: string | undefined;
for (let i = 0; i < args.length; i++) {
  const flag = args[i]!;
  if (flag === "--help" || flag === "-h") { help(); process.exit(0); }
  if (flag === "--version" || flag === "-v") { console.log(packageJson.version); process.exit(0); }
  const value = args[++i];
  if (!value) throw new Error(`${flag} requires a value`);
  if (flag === "--env") envFile = resolve(value);
  else {
    const key = flagEnvironment[flag];
    if (!key) throw new Error(`Unknown option: ${flag}`);
    process.env[key] = value;
  }
}
if (command === "help") { help(); process.exit(0); }
if (command === "version") { console.log(packageJson.version); process.exit(0); }

const candidateEnv = envFile ?? resolve(process.cwd(), ".env");
if (envFile && !existsSync(envFile)) throw new Error(`Environment file not found: ${envFile}`);
if (existsSync(candidateEnv)) process.loadEnvFile(candidateEnv);

function claudeDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim();
  if (!configured) return join(homedir(), ".claude");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return resolve(homedir(), configured.slice(2));
  }
  return resolve(configured);
}

function setupInstalled(): boolean {
  try {
    const config = JSON.parse(readFileSync(join(claudeDir(), "discord-presence", "config.json"), "utf8"));
    const settings = readFileSync(join(claudeDir(), "settings.json"), "utf8");
    return config.installerVersion === 1 && /discord-presence[\\/]hook\.mjs/i.test(settings) &&
      /discord-presence[\\/]statusline\.mjs/i.test(settings);
  } catch {
    return false;
  }
}

function runScript(name: string): void {
  const result = spawnSync(process.execPath, [resolve(projectDir, "scripts", name)], {
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (command === "setup") { runScript("setup-claude.mjs"); process.exit(0); }
if (command === "remote:setup") { runScript("install-remote.mjs"); process.exit(0); }
if (command === "autostart") {
  if (!setupInstalled()) runScript("setup-claude.mjs");
  runScript("install-autostart.mjs");
  process.exit(0);
}
if (command === "autostart:remove") { runScript("remove-autostart.mjs"); process.exit(0); }
if (command !== "start") throw new Error(`Unknown command: ${command}`);
if (!setupInstalled()) runScript("setup-claude.mjs");
await import("./index.js");
