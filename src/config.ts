import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { defaultDesktopSessionsDir } from "./claude/desktop-focus.ts";

export interface Config {
  applicationId: string;
  appName: string;
  port: number;
  largeImageKey?: string;
  largeImageKeyLight?: string;
  largeImageKeyDark?: string;
  largeImageUrl?: string;
  smallImageKey?: string;
  smallImageKeyLight?: string;
  smallImageKeyDark?: string;
  smallImageUrl?: string;
  usagePollIntervalMs: number;
  desktopSessionsDir?: string;
  dataDir: string;
  logFile: string;
  remoteHosts: string[];
  remotePort: number;
}

const SSH_ALIAS = /^[a-z0-9](?:[a-z0-9._-]{0,252}[a-z0-9])?$/i;
export const DEFAULT_DISCORD_APPLICATION_ID = "1524135246633894049";

export function resolveRemoteHosts(value: string | undefined): string[] {
  if (!value?.trim() || value.trim().toLowerCase() === "off") return [];
  const hosts = [...new Set(value.split(",").map((host) => host.trim()).filter(Boolean))];
  const invalid = hosts.find((host) => !SSH_ALIAS.test(host));
  if (invalid) {
    throw new Error(`CLAUDE_REMOTE_HOSTS contains an unsafe SSH alias: ${JSON.stringify(invalid)}`);
  }
  return hosts;
}

export interface RuntimePaths {
  userHome: string;
  cwd: string;
  platform: NodeJS.Platform;
}

function runtimePaths(): RuntimePaths {
  return { userHome: homedir(), cwd: process.cwd(), platform: process.platform };
}

function readInt(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || ["off", "none", "default"].includes(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

function resolveUserPath(value: string, runtime: RuntimePaths): string {
  if (value === "~") return runtime.userHome;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(runtime.userHome, value.slice(2));
  }
  return isAbsolute(value) ? resolve(value) : resolve(runtime.cwd, value);
}

export function resolvePresenceDataDir(
  env: Record<string, string | undefined>,
  runtime: RuntimePaths,
): string {
  const configured = env.CLAUDE_PRESENCE_DATA_DIR?.trim();
  if (configured) return resolveUserPath(configured, runtime);
  if (runtime.platform === "win32") {
    return join(env.LOCALAPPDATA?.trim() || join(runtime.userHome, "AppData", "Local"), "Claude Code Discord Presence");
  }
  if (runtime.platform === "darwin") {
    return join(runtime.userHome, "Library", "Application Support", "Claude Code Discord Presence");
  }
  const state = env.XDG_STATE_HOME?.trim();
  return join(state ? resolveUserPath(state, runtime) : join(runtime.userHome, ".local", "state"), "claude-code-discord-presence");
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  runtime: RuntimePaths = runtimePaths(),
): Config {
  const applicationId =
    (env.CLAUDE_DISCORD_APPLICATION_ID ?? env.DISCORD_APPLICATION_ID)?.trim() ||
    DEFAULT_DISCORD_APPLICATION_ID;
  const dataDir = resolvePresenceDataDir(env, runtime);
  const rawDesktopDir = env.CLAUDE_DESKTOP_SESSIONS_DIR?.trim();
  const desktopSessionsDir = rawDesktopDir?.toLowerCase() === "off"
    ? undefined
    : rawDesktopDir
      ? resolveUserPath(rawDesktopDir, runtime)
      : defaultDesktopSessionsDir();
  const configuredLog = env.RPC_LOG_FILE?.trim();
  const port = readInt(env.PORT, 41724);
  return {
    applicationId,
    appName: env.CLAUDE_APP_NAME?.trim() || env.APP_NAME?.trim() || "Claude Code",
    port,
    largeImageKey: optional(env.CLAUDE_LARGE_IMAGE_KEY ?? env.LARGE_IMAGE_KEY ?? "claude_code"),
    largeImageKeyLight: optional(
      env.CLAUDE_LARGE_IMAGE_KEY_LIGHT ?? env.LARGE_IMAGE_KEY_LIGHT ?? "claude-liquid-light",
    ),
    largeImageKeyDark: optional(
      env.CLAUDE_LARGE_IMAGE_KEY_DARK ?? env.LARGE_IMAGE_KEY_DARK ?? "claude-liquid-dark",
    ),
    largeImageUrl: optional(env.CLAUDE_LARGE_IMAGE_URL ?? env.LARGE_IMAGE_URL),
    smallImageKey: optional(
      env.CLAUDE_SMALL_IMAGE_KEY ?? env.SMALL_IMAGE_KEY ?? "claude-usage-stats",
    ),
    smallImageKeyLight: optional(
      env.CLAUDE_SMALL_IMAGE_KEY_LIGHT ?? env.SMALL_IMAGE_KEY_LIGHT ?? "claude-stats-light",
    ),
    smallImageKeyDark: optional(
      env.CLAUDE_SMALL_IMAGE_KEY_DARK ?? env.SMALL_IMAGE_KEY_DARK ?? "claude-stats-dark",
    ),
    smallImageUrl: optional(env.CLAUDE_SMALL_IMAGE_URL ?? env.SMALL_IMAGE_URL),
    usagePollIntervalMs: readInt(env.USAGE_POLL_INTERVAL_S, 300) * 1000,
    desktopSessionsDir,
    dataDir,
    logFile: configuredLog ? resolveUserPath(configuredLog, runtime) : join(dataDir, "claude-code-discord-presence.log"),
    remoteHosts: resolveRemoteHosts(env.CLAUDE_REMOTE_HOSTS),
    remotePort: readInt(env.CLAUDE_REMOTE_PORT, port),
  };
}
