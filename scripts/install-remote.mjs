import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SSH_ALIAS = /^[a-z0-9](?:[a-z0-9._-]{0,252}[a-z0-9])?$/i;
const hosts = [...new Set((process.env.CLAUDE_REMOTE_HOSTS || "")
  .split(",").map((host) => host.trim()).filter(Boolean))];
if (hosts.length === 0) throw new Error("Set CLAUDE_REMOTE_HOSTS to one or more SSH config aliases.");
const invalid = hosts.find((host) => !SSH_ALIAS.test(host));
if (invalid) throw new Error(`Unsafe SSH alias: ${JSON.stringify(invalid)}`);
const port = Number(process.env.CLAUDE_REMOTE_PORT || process.env.PORT || 41724);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid CLAUDE_REMOTE_PORT");

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const [setup, hook, statusline] = await Promise.all([
  readFile(join(scriptsDir, "setup-remote.mjs"), "utf8"),
  readFile(join(scriptsDir, "hook.mjs")),
  readFile(join(scriptsDir, "statusline.mjs")),
]);
const hookBase64 = hook.toString("base64");
const statuslineBase64 = statusline.toString("base64");

async function install(host) {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    host,
    "node", "-", String(port), hookBase64, statuslineBase64,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-8_192); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8_192); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        if (stdout.trim()) console.log(`[${host}] ${stdout.trim()}`);
        resolve();
      } else {
        reject(new Error(`Remote setup failed for ${host}: ${stderr.trim() || `exit ${code}`}`));
      }
    });
    child.stdin.end(setup);
  });
}

await Promise.all(hosts.map(install));
console.log("Remote hooks are installed. The presence service maintains loopback-only reverse SSH tunnels automatically.");
