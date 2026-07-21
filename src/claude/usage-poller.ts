import { watch, type FSWatcher } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Limits, UsageApiResponse } from "../types.ts";
import { limitsFromUsage } from "./limits.ts";
import { readOauthCredentials, saveRefreshedCredentials, CREDENTIALS_PATH } from "./plan-info.ts";
import { discoverOauthConfig, type OauthConfig } from "./oauth-discovery.ts";
import { createLogger } from "../util/logger.ts";

const log = createLogger("usage");
const execFileAsync = promisify(execFile);
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const EXPIRY_SLACK_MS = 60_000;
const EXPIRED_RETRY_MS = 5 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const FALLBACK_CLI_VERSION = "2.1.204";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export class UsagePoller {
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight = false;
  private stopped = false;
  private latest?: Limits;
  private consecutiveFailures = 0;
  private lastRefreshAt = 0;
  private refreshing = false;
  private userAgent?: string;
  private oauthConfig?: Promise<OauthConfig>;
  private watcher?: FSWatcher;
  private watchDebounce?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly intervalMs: number,
    private readonly onUpdate: (limits: Limits) => void,
  ) {}

  getLatest(): Limits | undefined {
    return this.latest;
  }

  start(): void {
    this.stopped = false;
    this.watchCredentials();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watcher?.close();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private jitter(base: number): number {
    const spread = base * 0.2;
    return base + Math.floor((0.5 - Math.abs((Date.now() % 1000) / 1000 - 0.5)) * spread);
  }

  private watchCredentials(): void {
    if (process.platform === "darwin") return;
    try {
      this.watcher = watch(CREDENTIALS_PATH, () => {
        if (this.watchDebounce) clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => {
          if (this.stopped) return;
          log.debug("credentials changed; polling usage");
          void this.tick();
        }, 2_000);
      });
    } catch (err) {
      log.debug(`credentials watch unavailable: ${(err as Error).message}`);
    }
  }

  private async getUserAgent(): Promise<string> {
    if (this.userAgent) return this.userAgent;
    let version = FALLBACK_CLI_VERSION;
    try {
      const { stdout } = await execFileAsync("claude", ["-v"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      });
      const match = stdout.match(/(\d+\.\d+\.\d+)/);
      if (match) version = match[1]!;
    } catch (err) {
      log.debug(`claude version probe failed: ${(err as Error).message}`);
    }
    this.userAgent = `claude-code/${version}`;
    return this.userAgent;
  }

  private refreshEnabled(): boolean {
    const raw = process.env.USAGE_TOKEN_REFRESH?.trim().toLowerCase();
    return raw === "on" || raw === "1" || raw === "true";
  }

  private async refreshToken(): Promise<boolean> {
    if (!this.refreshEnabled() || this.refreshing) return false;
    const now = Date.now();
    if (now - this.lastRefreshAt < REFRESH_COOLDOWN_MS) return false;
    this.lastRefreshAt = now;
    this.refreshing = true;
    try {
      const creds = await readOauthCredentials();
      if (!creds.refreshToken) {
        log.warn("no refresh token available; cannot refresh access token");
        return false;
      }
      this.oauthConfig ??= discoverOauthConfig();
      const config = await this.oauthConfig;
      for (const clientId of config.clientIds) {
        for (const url of config.tokenUrls) {
          const host = new URL(url).host;
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                grant_type: "refresh_token",
                refresh_token: creds.refreshToken,
                client_id: clientId,
              }),
            });
            if (!res.ok) {
              log.warn(`token refresh failed at ${host} (client ${clientId.slice(0, 8)}): ${res.status}`);
              continue;
            }
            const data = (await res.json()) as TokenResponse;
            if (!data.access_token) {
              log.warn(`token refresh response from ${host} missing access_token`);
              continue;
            }
            const saved = await saveRefreshedCredentials(data.access_token, data.refresh_token, data.expires_in);
            if (saved) log.info("access token refreshed and saved");
            return saved;
          } catch (err) {
            log.warn(`token refresh error at ${host}: ${(err as Error).message}`);
          }
        }
      }
      return false;
    } finally {
      this.refreshing = false;
    }
  }

  private tokenExpired(expiresAt: number | undefined): boolean {
    return expiresAt !== undefined && expiresAt < Date.now() + EXPIRY_SLACK_MS;
  }

  private async tick(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    let nextDelay = this.intervalMs;
    try {
      let creds = await readOauthCredentials();
      if (this.tokenExpired(creds.expiresAt)) {
        if (await this.refreshToken()) creds = await readOauthCredentials();
        if (this.tokenExpired(creds.expiresAt)) {
          this.consecutiveFailures++;
          nextDelay = EXPIRED_RETRY_MS;
          log.warn("access token expired; waiting for a refresh before polling usage");
          return;
        }
      }
      if (!creds.accessToken) {
        log.warn("no access token available; retrying");
        this.consecutiveFailures++;
        nextDelay = Math.min(this.intervalMs, 60_000);
        return;
      }

      const res = await fetch(USAGE_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "Content-Type": "application/json",
          "User-Agent": await this.getUserAgent(),
        },
      });

      if (res.status === 429) {
        this.consecutiveFailures++;
        const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** this.consecutiveFailures);
        nextDelay = this.jitter(backoff);
        log.warn(`rate limited (429); backing off ${Math.round(nextDelay / 1000)}s`);
        return;
      }

      if (res.status === 401 || res.status === 403) {
        this.consecutiveFailures++;
        const refreshed = await this.refreshToken();
        nextDelay = refreshed ? 10_000 : EXPIRED_RETRY_MS;
        log.warn(
          `usage auth failed (${res.status}); ${refreshed ? "retrying with the refreshed token" : "waiting for a token refresh"}`,
        );
        return;
      }

      if (!res.ok) {
        this.consecutiveFailures++;
        nextDelay = this.jitter(Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** this.consecutiveFailures));
        log.warn(`usage request failed: ${res.status}`);
        return;
      }

      let parsed: UsageApiResponse;
      try {
        parsed = (await res.json()) as UsageApiResponse;
      } catch {
        this.consecutiveFailures++;
        nextDelay = 5_000;
        log.warn("usage response parse failed; retrying shortly");
        return;
      }

      const limits = limitsFromUsage(parsed, Date.now());
      this.consecutiveFailures = 0;
      if (limits) {
        this.latest = limits;
        const scoped = limits.sevenDayScoped?.map((s) => `${s.label}=${s.usedPercentage}`).join(",") ?? "-";
        log.debug(
          `usage ok: 5h used=${limits.fiveHour?.usedPercentage ?? "-"} 7d used=${limits.sevenDay?.usedPercentage ?? "-"} scoped=${scoped}`,
        );
        this.onUpdate(limits);
      }
    } catch (err) {
      this.consecutiveFailures++;
      nextDelay = this.jitter(Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** this.consecutiveFailures));
      log.warn(`usage poll error: ${(err as Error).message}`);
    } finally {
      this.inFlight = false;
      this.schedule(nextDelay);
    }
  }
}
