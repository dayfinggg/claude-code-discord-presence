import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../util/logger.ts";
import { claudeConfigDir } from "./paths.ts";

const log = createLogger("app-liveness");
const POLL_MS = 15_000;

export type AppLivenessSink = (alive: boolean, earliestStartedAt?: number, pid?: number) => void;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ClaudeAppLiveness {
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;
  private stopped = false;
  private lastAlive?: boolean;

  constructor(
    private readonly onUpdate: AppLivenessSink,
    private readonly dir: string = join(claudeConfigDir(), "sessions"),
  ) {}

  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async scan(): Promise<void> {
    if (this.stopped || this.scanning) return;
    this.scanning = true;
    try {
      let alive = false;
      let earliest: number | undefined;
      let pid: number | undefined;
      let entries: string[] = [];
      try {
        entries = await readdir(this.dir);
      } catch {
        entries = [];
      }
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        let obj: { pid?: unknown; startedAt?: unknown };
        try {
          obj = JSON.parse(await readFile(join(this.dir, name), "utf8"));
        } catch {
          continue;
        }
        if (typeof obj.pid !== "number" || !processAlive(obj.pid)) continue;
        alive = true;
        if (typeof obj.startedAt === "number" && (earliest === undefined || obj.startedAt < earliest)) {
          earliest = obj.startedAt;
          pid = obj.pid;
        } else if (pid === undefined) {
          pid = obj.pid;
        }
      }
      if (alive !== this.lastAlive) {
        this.lastAlive = alive;
        log.debug(`claude processes alive=${alive}${earliest !== undefined ? ` earliestStartedAt=${earliest}` : ""}`);
      }
      this.onUpdate(alive, earliest, pid);
    } finally {
      this.scanning = false;
    }
  }
}
