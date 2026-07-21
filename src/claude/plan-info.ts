import { join } from "node:path";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createLogger } from "../util/logger.ts";
import type { EffortLevel } from "../types.ts";
import { claudeConfigDir } from "./paths.ts";

const log = createLogger("plan-info");
const execFileAsync = promisify(execFile);
const CLAUDE_DIR = claudeConfigDir();
export const CREDENTIALS_PATH = join(CLAUDE_DIR, ".credentials.json");
const MACOS_KEYCHAIN_SERVICES = ["Claude Code-credentials", "Claude Code"] as const;
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const CACHE_TTL_MS = 60 * 60 * 1000;
const EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

export async function getDefaultEffort(): Promise<EffortLevel | undefined> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const level = (JSON.parse(raw) as { effortLevel?: unknown }).effortLevel;
    return typeof level === "string" && EFFORT_LEVELS.has(level) ? (level as EffortLevel) : undefined;
  } catch {
    return undefined;
  }
}

export function planNameFrom(subscriptionType?: string, rateLimitTier?: string): string {
  const sub = (subscriptionType ?? "").toLowerCase();
  const tier = (rateLimitTier ?? "").toLowerCase();
  if (sub === "pro") return "Pro";
  if (sub === "max") {
    if (tier.includes("20x")) return "Max 20X";
    if (tier.includes("5x")) return "Max 5X";
    return "Max";
  }
  if (sub === "team" || sub === "enterprise") return sub.charAt(0).toUpperCase() + sub.slice(1);
  return "Claude";
}

interface CredentialsShape {
  claudeAiOauth?: {
    subscriptionType?: string;
    rateLimitTier?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

type ReadCredentialsFile = (path: string, encoding: BufferEncoding) => Promise<string>;
type ReadMacosKeychain = () => Promise<string | undefined>;
type SecurityRunner = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const runSecurity: SecurityRunner = async (file, args, options) =>
  execFileAsync(file, args, options);

function parseCredentials(raw: string): CredentialsShape | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as CredentialsShape) : undefined;
  } catch {
    return undefined;
  }
}

export async function readMacosKeychainCredentials(
  run: SecurityRunner = runSecurity,
): Promise<string | undefined> {
  for (const service of MACOS_KEYCHAIN_SERVICES) {
    try {
      const { stdout } = await run(
        "/usr/bin/security",
        ["find-generic-password", "-s", service, "-w"],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 512 * 1024 },
      );
      if (stdout.trim()) return stdout.trim();
    } catch {
      // Try the legacy service name before falling back to the credentials file.
    }
  }
  return undefined;
}

export async function readCredentialsForPlatform(
  platform: NodeJS.Platform,
  readCredentialsFile: ReadCredentialsFile,
  readKeychain: ReadMacosKeychain,
): Promise<CredentialsShape | undefined> {
  if (platform === "darwin") {
    const keychainRaw = await readKeychain();
    const keychainCredentials = keychainRaw ? parseCredentials(keychainRaw) : undefined;
    if (keychainCredentials) return keychainCredentials;
  }
  try {
    return parseCredentials(await readCredentialsFile(CREDENTIALS_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

export interface OauthCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

async function readCredentials(): Promise<CredentialsShape | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const credentials = await readCredentialsForPlatform(
        process.platform,
        readFile,
        readMacosKeychainCredentials,
      );
      if (credentials) return credentials;
      throw Object.assign(new Error("Claude Code credentials were not found"), { code: "ENOENT" });
    } catch (err) {
      if (attempt === 2) {
        const error = err as NodeJS.ErrnoException;
        const message = `could not read credentials: ${error.message}`;
        if (error.code === "ENOENT") log.debug(message);
        else log.warn(message);
        return undefined;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return undefined;
}

export async function readAccessToken(): Promise<string | undefined> {
  const creds = await readCredentials();
  return creds?.claudeAiOauth?.accessToken;
}

export async function readOauthCredentials(): Promise<OauthCredentials> {
  const oauth = (await readCredentials())?.claudeAiOauth;
  return {
    accessToken: oauth?.accessToken,
    refreshToken: oauth?.refreshToken,
    expiresAt: typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined,
  };
}

export async function saveRefreshedCredentials(
  accessToken: string,
  refreshToken: string | undefined,
  expiresInS: number | undefined,
): Promise<boolean> {
  if (process.platform === "darwin") {
    log.warn("token refresh cannot update macOS Keychain; Claude Code will refresh its credentials");
    return false;
  }
  try {
    const raw = await readFile(CREDENTIALS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth =
      parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object"
        ? (parsed.claudeAiOauth as Record<string, unknown>)
        : {};
    oauth.accessToken = accessToken;
    if (refreshToken) oauth.refreshToken = refreshToken;
    if (typeof expiresInS === "number" && Number.isFinite(expiresInS) && expiresInS > 0) {
      oauth.expiresAt = Date.now() + Math.round(expiresInS * 1000);
    }
    parsed.claudeAiOauth = oauth;
    await writeFile(CREDENTIALS_PATH, JSON.stringify(parsed), "utf8");
    return true;
  } catch (err) {
    log.warn(`could not save refreshed credentials: ${(err as Error).message}`);
    return false;
  }
}

let cached: { name: string; at: number } | undefined;

export async function getPlanName(): Promise<string> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.name;
  const creds = await readCredentials();
  const oauth = creds?.claudeAiOauth;
  const name = planNameFrom(oauth?.subscriptionType, oauth?.rateLimitTier);
  cached = { name, at: now };
  return name;
}
