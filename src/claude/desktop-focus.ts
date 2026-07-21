import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../util/logger.ts";

const log = createLogger("desktop-focus");
const POLL_MS = 2_000;
const RESCAN_DEBOUNCE_MS = 150;
const MAX_DEPTH = 4;

export interface DesktopFocus {
  cliSessionId: string;
  focusedAt: number;
  lastActivityAt?: number;
  updatedAt?: number;
  model?: string;
  effort?: string;
  failed?: boolean;
}

export type DesktopFocusSink = (focus: DesktopFocus) => void;

export function sameDesktopFocus(a: DesktopFocus | undefined, b: DesktopFocus): boolean {
  return Boolean(
    a &&
      a.cliSessionId === b.cliSessionId &&
      a.focusedAt === b.focusedAt &&
      a.model === b.model &&
      a.effort === b.effort &&
      a.failed === b.failed,
  );
}

export function defaultDesktopSessionsDir(): string | undefined {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData ? join(appData, "Claude", "claude-code-sessions") : undefined;
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
  }
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "Claude", "claude-code-sessions");
}

export function parseDesktopSession(text: string): DesktopFocus | undefined {
  let obj: {
    cliSessionId?: unknown;
    lastFocusedAt?: unknown;
    lastActivityAt?: unknown;
    model?: unknown;
    effort?: unknown;
    isArchived?: unknown;
    error?: unknown;
  };
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== "object" || obj.isArchived === true) return undefined;
  const cliSessionId = obj.cliSessionId;
  const focusedAt = obj.lastFocusedAt;
  if (typeof cliSessionId !== "string" || cliSessionId === "") return undefined;
  if (typeof focusedAt !== "number" || !Number.isFinite(focusedAt) || focusedAt <= 0) return undefined;
  const focus: DesktopFocus = { cliSessionId, focusedAt };
  if (typeof obj.lastActivityAt === "number" && Number.isFinite(obj.lastActivityAt) && obj.lastActivityAt > 0) {
    focus.lastActivityAt = obj.lastActivityAt;
  }
  if (typeof obj.model === "string" && obj.model !== "") focus.model = obj.model;
  if (typeof obj.effort === "string" && obj.effort !== "") focus.effort = obj.effort;
  if (
    (typeof obj.error === "string" && obj.error.trim() !== "") ||
    (obj.error !== undefined && obj.error !== null && obj.error !== false && typeof obj.error !== "string")
  ) {
    focus.failed = true;
  }
  return focus;
}

export class DesktopFocusWatcher {
  private watcher?: FSWatcher;
  private pollTimer?: ReturnType<typeof setInterval>;
  private rescanTimer?: ReturnType<typeof setTimeout>;
  private scanning = false;
  private readonly mtimes = new Map<string, number>();
  private readonly byFile = new Map<string, DesktopFocus>();
  private lastReported?: DesktopFocus;
  private stopped = false;

  constructor(private readonly dir: string, private readonly onFocus: DesktopFocusSink) {}

  async start(): Promise<void> {
    await this.scan();
    try {
      this.watcher = watch(this.dir, { recursive: true }, () => this.scheduleScan());
      this.watcher.on("error", (err) => log.warn(`watch error: ${err.message}`));
      log.info(`watching ${this.dir}`);
    } catch (err) {
      log.warn(`fs.watch unavailable for ${this.dir}: ${(err as Error).message}; relying on poll`);
    }
    this.pollTimer = setInterval(() => void this.scan(), POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.watcher) this.watcher.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
  }

  private scheduleScan(): void {
    if (this.stopped || this.rescanTimer) return;
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      void this.scan();
    }, RESCAN_DEBOUNCE_MS);
  }

  private async scan(): Promise<void> {
    if (this.stopped || this.scanning) return;
    this.scanning = true;
    try {
      await this.scanLocked();
    } catch (err) {
      log.debug(`scan failed: ${(err as Error).message}`);
    } finally {
      this.scanning = false;
    }
  }

  private async listSessionFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH) await walk(full, depth + 1);
        } else if (entry.name.startsWith("local_") && entry.name.endsWith(".json")) {
          out.push(full);
        }
      }
    };
    await walk(this.dir, 0);
    return out;
  }

  private async scanLocked(): Promise<void> {
    const files = await this.listSessionFiles();
    const seen = new Set(files);
    for (const file of this.mtimes.keys()) {
      if (!seen.has(file)) {
        this.mtimes.delete(file);
        this.byFile.delete(file);
      }
    }

    for (const file of files) {
      let mtime;
      try {
        mtime = (await stat(file)).mtimeMs;
      } catch {
        continue;
      }
      if (this.mtimes.get(file) === mtime) continue;
      let text;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const parsed = parseDesktopSession(text);
      if (!parsed) {
        this.mtimes.delete(file);
        this.byFile.delete(file);
        continue;
      }
      parsed.updatedAt = mtime;
      this.mtimes.set(file, mtime);
      this.byFile.set(file, parsed);
    }

    let best: DesktopFocus | undefined;
    for (const focus of this.byFile.values()) {
      if (!best || focus.focusedAt > best.focusedAt) best = focus;
    }
    if (!best) return;
    if (sameDesktopFocus(this.lastReported, best)) return;
    this.lastReported = { ...best };
    log.debug(
      `focused session=${best.cliSessionId.slice(0, 8)} at=${best.focusedAt} ` +
        `model=${best.model ?? "-"} effort=${best.effort ?? "-"} failed=${best.failed ? "yes" : "no"}`,
    );
    this.onFocus(best);
  }
}
