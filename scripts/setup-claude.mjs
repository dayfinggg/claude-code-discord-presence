import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectDir = dirname(scriptsDir);
const configuredDir = process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim();
const expandHome = (path) => path === "~" ? homedir()
  : path.startsWith("~/") || path.startsWith("~\\") ? resolve(homedir(), path.slice(2))
  : resolve(path);
const claudeDir = configuredDir ? expandHome(configuredDir) : join(homedir(), ".claude");
const settingsPath = join(claudeDir, "settings.json");
const installDir = join(claudeDir, "discord-presence");
const backupDir = join(claudeDir, "backups", "claude-code-presence");
const hookTarget = join(installDir, "hook.mjs");
const statuslineTarget = join(installDir, "statusline.mjs");
const events = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "Notification",
  "SessionEnd",
];
const matcherEvents = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

function readPort() {
  const fromEnvironment = Number(process.env.PORT);
  if (Number.isInteger(fromEnvironment) && fromEnvironment > 0 && fromEnvironment <= 65_535) {
    return fromEnvironment;
  }
  try {
    const match = readFileSync(join(projectDir, ".env"), "utf8").match(/^PORT=(\d+)\s*$/m);
    const port = Number(match?.[1] || 41724);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
  } catch {}
  return 41724;
}

function shellCommand(executable, script) {
  const quote = (value) => `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
  return `${quote(executable)} ${quote(script)}`;
}

function isPresenceHook(hook, port) {
  if (!hook || typeof hook !== "object") return false;
  if (typeof hook.command === "string") {
    return /discord-rpc-hook|discord-presence[\\/]hook\.mjs/i.test(hook.command);
  }
  if (typeof hook.url !== "string") return false;
  try {
    const url = new URL(hook.url);
    return ["127.0.0.1", "localhost"].includes(url.hostname) &&
      url.pathname === "/hook" && [String(port), "41724"].includes(url.port || "80");
  } catch {
    return false;
  }
}

async function retainLatestBackups(limit) {
  const entries = await readdir(backupDir).catch(() => []);
  const candidates = [];
  for (const name of entries) {
    if (!/^settings-\d+\.json$/.test(name)) continue;
    const path = join(backupDir, name);
    candidates.push({ path, modifiedAt: (await stat(path)).mtimeMs });
  }
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  await Promise.all(candidates.slice(limit).map(({ path }) => rm(path, { force: true })));
}

const port = readPort();
await mkdir(installDir, { recursive: true });
await mkdir(backupDir, { recursive: true });
await copyFile(join(scriptsDir, "hook.mjs"), hookTarget);
await copyFile(join(scriptsDir, "statusline.mjs"), statuslineTarget);
await writeFile(
  join(installDir, "config.json"),
  `${JSON.stringify({ port, remote: false, installerVersion: 2 }, null, 2)}\n`,
  { mode: 0o600 },
);

let settings = {};
if (existsSync(settingsPath)) {
  const raw = await readFile(settingsPath, "utf8");
  const backup = join(backupDir, `settings-${Date.now()}.json`);
  await writeFile(backup, raw, { mode: 0o600 });
  try {
    settings = JSON.parse(raw);
  } catch {
    throw new Error(`Existing settings are not valid JSON. The original was backed up to ${backup}.`);
  }
  await retainLatestBackups(5);
}

const hookCommand = shellCommand(process.execPath, hookTarget);
const statuslineCommand = shellCommand(process.execPath, statuslineTarget);
const existingStatusline = settings.statusLine?.command;
if (!existingStatusline || /discord-rpc-statusline|discord-presence[\\/]statusline\.mjs/i.test(existingStatusline)) {
  settings.statusLine = { type: "command", command: statuslineCommand };
}

if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
  settings.hooks = {};
}
for (const event of events) {
  const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const cleaned = [];
  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
      cleaned.push(group);
      continue;
    }
    const hooks = group.hooks.filter((hook) => !isPresenceHook(hook, port));
    if (hooks.length > 0) cleaned.push({ ...group, hooks });
  }
  const presence = {
    ...(matcherEvents.has(event) ? { matcher: "*" } : {}),
    hooks: [{ type: "command", command: hookCommand, async: true, timeout: 5 }],
  };
  settings.hooks[event] = [...cleaned, presence];
}

await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
console.log(`Installed Claude Code hooks and statusline in ${installDir}`);
console.log(`Updated ${settingsPath}; restart active Claude Code sessions to load the changes.`);
