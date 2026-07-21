import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLaunchAgentPlist, createSystemdUserUnit } from "../dist/util/autostart.js";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const entryPoint = join(projectDir, "dist", "index.js");
const envFile = join(projectDir, ".env");
const label = "com.claude-code.discord-presence";
const definition = {
  label,
  description: "Claude Code Discord Presence",
  nodePath: process.execPath,
  projectDir,
  envFile: existsSync(envFile) ? envFile : undefined,
  entryPoint,
};

if (!existsSync(entryPoint)) throw new Error("Built service not found. Run npm run build first.");

if (process.platform === "win32") {
  execFileSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(projectDir, "scripts", "setup-autostart.ps1"),
  ], { stdio: "inherit", windowsHide: true });
} else if (process.platform === "darwin") {
  const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, createLaunchAgentPlist(definition), { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  try { execFileSync("launchctl", ["bootout", domain, path], { stdio: "ignore" }); } catch {}
  execFileSync("launchctl", ["bootstrap", domain, path], { stdio: "inherit" });
  execFileSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "inherit" });
  console.log(`Installed ${path}`);
} else if (process.platform === "linux") {
  const unitName = "claude-code-discord-presence.service";
  const path = join(homedir(), ".config", "systemd", "user", unitName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, createSystemdUserUnit(definition), { mode: 0o600 });
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", ["--user", "enable", "--now", unitName], { stdio: "inherit" });
  console.log(`Installed ${path}`);
} else {
  throw new Error(`Autostart is not supported on ${process.platform}.`);
}
