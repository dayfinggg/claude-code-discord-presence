import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createLogger } from "../util/logger.ts";
import type { EffortLevel } from "../types.ts";
import { claudeConfigDir } from "./paths.ts";

const log = createLogger("plan-info");
const CLAUDE_DIR = claudeConfigDir();
export const CREDENTIALS_PATH = join(CLAUDE_DIR, ".credentials.json");
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

export interface OauthCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

async function readCredentials(): Promise<CredentialsShape | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await readFile(CREDENTIALS_PATH, "utf8");
      return JSON.parse(raw) as CredentialsShape;
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
