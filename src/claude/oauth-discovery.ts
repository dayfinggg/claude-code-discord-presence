import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import { createLogger } from "../util/logger.ts";

const execFileAsync = promisify(execFile);
const log = createLogger("oauth-discovery");

export const FALLBACK_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const FALLBACK_TOKEN_URLS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];

const CLIENT_RE =
  /MANUAL_REDIRECT_URL:"https:\/\/[a-z0-9.\-]+\/oauth\/code\/callback",CLIENT_ID:"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g;
const TOKEN_URL_RE = /https:\/\/[a-z0-9.\-]+\/v1\/oauth\/token/g;
const CHUNK_BYTES = 8 * 1024 * 1024;
const OVERLAP_BYTES = 1024;

export interface OauthConfig {
  clientIds: string[];
  tokenUrls: string[];
}

function ownHost(url: string): boolean {
  return url.includes("claude.com") || url.includes("anthropic.com");
}

function push(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

async function findClaudeExecutable(): Promise<string | undefined> {
  try {
    const command = process.platform === "win32" ? "where.exe" : "which";
    const { stdout } = await execFileAsync(command, ["claude"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

export async function discoverOauthConfig(): Promise<OauthConfig> {
  const clientIds: string[] = [];
  const tokenUrls: string[] = [];
  const envId = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID?.trim();
  if (envId) push(clientIds, envId);

  let discovered: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const executable = await findClaudeExecutable();
    if (executable) {
      handle = await open(executable, "r");
      const size = (await handle.stat()).size;
      const decoder = new TextDecoder();
      let carry = "";
      for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        const text = carry + decoder.decode(buffer.subarray(0, bytesRead));
        for (const match of text.matchAll(CLIENT_RE)) {
          discovered ??= match[1];
          push(clientIds, match[1]!);
        }
        for (const match of text.matchAll(TOKEN_URL_RE)) {
          if (ownHost(match[0])) push(tokenUrls, match[0]);
        }
        carry = text.slice(-OVERLAP_BYTES);
      }
    } else {
      log.debug("claude executable not found; using fallback oauth config");
    }
  } catch (err) {
    log.debug(`oauth discovery failed: ${(err as Error).message}; using fallback`);
  } finally {
    await handle?.close().catch(() => undefined);
  }

  push(clientIds, FALLBACK_CLIENT_ID);
  for (const url of FALLBACK_TOKEN_URLS) push(tokenUrls, url);
  log.debug(`oauth config source=${discovered ? "claude binary" : "fallback"}`);
  return { clientIds, tokenUrls };
}
