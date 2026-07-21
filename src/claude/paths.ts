import { homedir } from "node:os";
import { resolve } from "node:path";

export function claudeConfigDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim();
  if (!configured) return resolve(homedir(), ".claude");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return resolve(homedir(), configured.slice(2));
  }
  return resolve(configured);
}
