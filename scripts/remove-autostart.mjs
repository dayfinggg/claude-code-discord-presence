import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const label = "com.claude-code.discord-presence";

if (process.platform === "win32") {
  execFileSync("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(projectDir, "scripts", "remove-autostart.ps1"),
  ], { stdio: "inherit", windowsHide: true });
} else if (process.platform === "darwin") {
  const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  if (existsSync(path)) {
    try { execFileSync("launchctl", ["bootout", domain, path], { stdio: "ignore" }); } catch {}
    rmSync(path, { force: true });
  }
  console.log(`Removed ${path}`);
} else if (process.platform === "linux") {
  const unitName = "claude-code-discord-presence.service";
  const path = join(homedir(), ".config", "systemd", "user", unitName);
  try { execFileSync("systemctl", ["--user", "disable", "--now", unitName], { stdio: "inherit" }); } catch {}
  rmSync(path, { force: true });
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  console.log(`Removed ${path}`);
} else {
  throw new Error(`Autostart is not supported on ${process.platform}.`);
}
