import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 512 * 1024;
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > MAX_BYTES) process.exit(0);
}

try {
  const configPath = join(dirname(fileURLToPath(import.meta.url)), "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const port = Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) process.exit(0);
  let body = raw.trim() || "{}";
  if (config.remote === true) {
    try {
      const payload = JSON.parse(body);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        body = JSON.stringify({ ...payload, remote: true });
      }
    } catch {}
  }
  await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(1_000),
  }).catch(() => undefined);
} catch {}
