import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "./logger.ts";
import {
  matchesWindowsProcess,
  type ProcessLivenessSink,
  type WindowsProcessInfo,
  type WindowsProcessRule,
} from "./process-liveness.ts";

const log = createLogger("proc-scan");
const SCAN_INTERVAL_S = 5;
const RESTART_DELAY_MS = 1_000;
const STALL_TIMEOUT_MS = 30_000;
const DEAD_CONFIRMATIONS = 2;

function buildScript(nameFilter: string): string {
  return String.raw`
$namePattern = '${nameFilter.replace(/'/g, "''")}'
while ($true) {
  $items = @(Get-CimInstance Win32_Process | ForEach-Object {
    $processName = [System.IO.Path]::GetFileNameWithoutExtension([string]$_.Name)
    if ($processName -match $namePattern) {
      $hasMainWindow = $false
      try { $hasMainWindow = (Get-Process -Id $_.ProcessId -ErrorAction Stop).MainWindowHandle -ne 0 } catch {}
      $startedAt = 0
      try { $startedAt = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } catch {}
      [PSCustomObject]@{
        pid = [int]$_.ProcessId
        name = $processName
        path = [string]$_.ExecutablePath
        commandLine = [string]$_.CommandLine
        hasMainWindow = $hasMainWindow
        startedAt = $startedAt
      }
    }
  })
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject @($items) -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Seconds ${SCAN_INTERVAL_S}
}
`;
}

function parseProcesses(raw: string): WindowsProcessInfo[] | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const result: WindowsProcessInfo[] = [];
    for (const value of parsed) {
      if (!value || typeof value !== "object") return undefined;
      const item = value as Record<string, unknown>;
      if (
        typeof item.name !== "string" ||
        typeof item.pid !== "number" ||
        !Number.isInteger(item.pid) ||
        item.pid <= 0 ||
        typeof item.path !== "string" ||
        typeof item.commandLine !== "string" ||
        typeof item.hasMainWindow !== "boolean" ||
        typeof item.startedAt !== "number" ||
        !Number.isFinite(item.startedAt)
      ) {
        return undefined;
      }
      result.push({
        pid: item.pid,
        name: item.name,
        path: item.path,
        commandLine: item.commandLine,
        hasMainWindow: item.hasMainWindow,
        startedAt: item.startedAt,
      });
    }
    return result;
  } catch {
    return undefined;
  }
}

export class ProcessRuleTracker {
  private lastAlive?: boolean;
  private deadStreak = 0;

  constructor(
    private readonly label: string,
    private readonly rules: readonly WindowsProcessRule[],
    private readonly onUpdate: ProcessLivenessSink,
  ) {}

  update(processes: readonly WindowsProcessInfo[]): void {
    let alive = false;
    let earliest: number | undefined;
    let pid: number | undefined;
    for (const info of processes) {
      if (!this.rules.some((rule) => matchesWindowsProcess(info, rule))) continue;
      alive = true;
      const ms = info.startedAt;
      if (Number.isFinite(ms) && ms > 0 && (earliest === undefined || ms < earliest)) {
        earliest = ms;
        pid = info.pid;
      } else if (pid === undefined) {
        pid = info.pid;
      }
    }
    if (alive) {
      this.deadStreak = 0;
    } else {
      this.deadStreak++;
      if (this.lastAlive === true && this.deadStreak < DEAD_CONFIRMATIONS) return;
    }
    if (alive !== this.lastAlive) {
      this.lastAlive = alive;
      log.debug(
        `${this.label} alive=${alive}` +
          (earliest !== undefined ? ` earliestStartedAt=${earliest}` : "") +
          (pid !== undefined ? ` pid=${pid}` : ""),
      );
    }
    this.onUpdate(alive, earliest, pid);
  }
}

export class WindowsProcessScanWatcher {
  private child?: ChildProcess;
  private stopped = false;
  private lastLineAt = 0;
  private stallTimer?: ReturnType<typeof setInterval>;
  private restartTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly nameFilter: string,
    private readonly onProcesses: (processes: WindowsProcessInfo[]) => void,
  ) {}

  start(): void {
    if (process.platform !== "win32" || this.child || this.stallTimer) return;
    this.stopped = false;
    this.lastLineAt = Date.now();
    this.stallTimer = setInterval(() => {
      if (this.child && Date.now() - this.lastLineAt > STALL_TIMEOUT_MS) {
        log.warn("process scan stalled; restarting the scanner");
        this.lastLineAt = Date.now();
        try {
          this.child.kill();
        } catch {}
      }
    }, STALL_TIMEOUT_MS);
    this.spawnChild();
  }

  stop(): void {
    this.stopped = true;
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = undefined;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.child?.kill();
    this.child = undefined;
  }

  private spawnChild(): void {
    if (this.stopped) return;
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", buildScript(this.nameFilter)],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    this.child = child;
    this.lastLineAt = Date.now();
    let pending = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) this.report(line);
    });
    child.on("error", (err) => log.debug(`scan spawn failed: ${err.message}`));
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
      if (this.stopped) return;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.spawnChild();
      }, RESTART_DELAY_MS);
    });
  }

  private report(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    this.lastLineAt = Date.now();
    const processes = parseProcesses(trimmed);
    if (!processes) {
      log.debug("process scan returned invalid JSON");
      return;
    }
    this.onProcesses(processes);
  }
}
