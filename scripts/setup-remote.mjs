import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid remote port");
const hookSource = Buffer.from(process.argv[3] || "", "base64");
const statuslineSource = Buffer.from(process.argv[4] || "", "base64");
if (hookSource.length === 0 || statuslineSource.length === 0) throw new Error("Missing hook scripts");

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
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "Stop", "StopFailure", "SubagentStart", "SubagentStop", "Notification", "SessionEnd",
];
const matcherEvents = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
const quote = (value) => `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
const hookCommand = `${quote(process.execPath)} ${quote(hookTarget)}`;
const statuslineCommand = `${quote(process.execPath)} ${quote(statuslineTarget)}`;

function isPresenceHook(hook) {
  if (!hook || typeof hook !== "object") return false;
  if (typeof hook.command === "string") {
    return /discord-rpc-hook|discord-presence[\\/]hook\.mjs/i.test(hook.command);
  }
  if (typeof hook.url !== "string") return false;
  try {
    const url = new URL(hook.url);
    return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hook";
  } catch {
    return false;
  }
}

async function retainBackups(limit) {
  const names = await readdir(backupDir).catch(() => []);
  const candidates = [];
  for (const name of names) {
    if (!/^settings-\d+\.json$/.test(name)) continue;
    const path = join(backupDir, name);
    candidates.push({ path, modifiedAt: (await stat(path)).mtimeMs });
  }
  candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  await Promise.all(candidates.slice(limit).map(({ path }) => rm(path, { force: true })));
}

await mkdir(installDir, { recursive: true });
await mkdir(backupDir, { recursive: true });
await writeFile(hookTarget, hookSource, { mode: 0o700 });
await writeFile(statuslineTarget, statuslineSource, { mode: 0o700 });
await writeFile(
  join(installDir, "config.json"),
  `${JSON.stringify({ port, remote: true, installerVersion: 2 }, null, 2)}\n`,
  { mode: 0o600 },
);

let settings = {};
if (existsSync(settingsPath)) {
  const raw = await readFile(settingsPath, "utf8");
  const backup = join(backupDir, `settings-${Date.now()}.json`);
  await writeFile(backup, raw, { mode: 0o600 });
  try { settings = JSON.parse(raw); }
  catch { throw new Error(`Remote settings are invalid JSON; backup: ${backup}`); }
  await retainBackups(5);
}

const existingStatusline = settings.statusLine?.command;
if (!existingStatusline || /discord-rpc-statusline|discord-presence[\\/]statusline\.mjs/i.test(existingStatusline)) {
  settings.statusLine = { type: "command", command: statuslineCommand };
}
if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) settings.hooks = {};
for (const event of events) {
  const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const cleaned = [];
  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
      cleaned.push(group);
      continue;
    }
    const hooks = group.hooks.filter((hook) => !isPresenceHook(hook));
    if (hooks.length > 0) cleaned.push({ ...group, hooks });
  }
  settings.hooks[event] = [...cleaned, {
    ...(matcherEvents.has(event) ? { matcher: "*" } : {}),
    hooks: [{ type: "command", command: hookCommand, async: true, timeout: 5 }],
  }];
}
await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
console.log(`Installed remote Claude Code presence in ${installDir}`);
