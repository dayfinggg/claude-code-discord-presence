import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 512 * 1024;
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > MAX_BYTES) process.exit(0);
}

let data = {};
try { data = JSON.parse(raw); } catch {}

const labels = {
  minimal: "Minimal",
  low: "Light",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};
const model = data?.model?.display_name || "Claude";
const effortLevel = data?.effort?.level;
const effort = effortLevel ? ` (${labels[effortLevel] || effortLevel})` : "";
const fast = data?.fast_mode === true ? " Fast" : "";
const left = (used) => Math.max(0, Math.min(100, Math.round(100 - used)));
const limits = [];
if (Number.isFinite(data?.rate_limits?.five_hour?.used_percentage)) {
  limits.push(`5h ${left(data.rate_limits.five_hour.used_percentage)}% left`);
}
if (Number.isFinite(data?.rate_limits?.seven_day?.used_percentage)) {
  limits.push(`7d ${left(data.rate_limits.seven_day.used_percentage)}% left`);
}
process.stdout.write(`${model}${effort}${fast}${limits.length ? ` • ${limits.join(" • ")}` : ""}`);

try {
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const port = Number(config.port);
  if (Number.isInteger(port) && port > 0 && port <= 65_535) {
    let body = raw.trim() || "{}";
    if (config.remote === true) {
      try {
        const payload = JSON.parse(body);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          body = JSON.stringify({ ...payload, remote: true });
        }
      } catch {}
    }
    await fetch(`http://127.0.0.1:${port}/statusline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined);
  }
} catch {}
