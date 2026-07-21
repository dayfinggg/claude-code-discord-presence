import { execFile } from "node:child_process";
import { createLogger } from "./logger.ts";

const log = createLogger("proc-liveness");
const POLL_MS = 20_000;
const SCAN_TIMEOUT_MS = 10_000;
const DEAD_CONFIRMATIONS = 2;

export type ProcessLivenessSink = (alive: boolean, earliestStartedAt?: number, pid?: number) => void;

export interface WindowsProcessRule {
  name: RegExp;
  path?: RegExp;
  commandLine?: RegExp;
  hasMainWindow?: boolean;
}

export interface ProcessLivenessOptions {
  windowsRules?: readonly WindowsProcessRule[];
  pollIntervalMs?: number;
}

export interface WindowsProcessInfo {
  pid: number;
  name: string;
  path: string;
  commandLine: string;
  hasMainWindow: boolean;
  startedAt: number;
}

export const CLAUDE_WINDOWS_PROCESS_RULES: readonly WindowsProcessRule[] = [
  { name: /^claude$/i, path: /\\WindowsApps\\Claude_/i, hasMainWindow: true },
  { name: /^claude$/i, path: /^(?!.*\\WindowsApps\\Claude_).+$/i },
];

export const CODEX_WINDOWS_PROCESS_RULES: readonly WindowsProcessRule[] = [
  { name: /^ChatGPT$/i, path: /\\WindowsApps\\OpenAI\.Codex_/i, hasMainWindow: true },
  { name: /^codex$/i, commandLine: /^(?!.*\bapp-server\b).+$/i },
];

function regexMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function parseElapsedTimeSeconds(value: string): number | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const dayParts = trimmed.split("-");
  if (dayParts.length > 2) return undefined;
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
  const clock = dayParts.at(-1)?.split(":") ?? [];
  if (clock.length < 2 || clock.length > 3 || clock.some((part) => !/^\d+$/.test(part))) {
    return undefined;
  }
  const numbers = clock.map(Number);
  const seconds = numbers.at(-1)!;
  const minutes = numbers.at(-2)!;
  const hours = numbers.length === 3 ? numbers[0]! : 0;
  if (seconds >= 60 || minutes >= 60 || (dayParts.length === 2 && hours >= 24)) return undefined;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

export function processCommandName(command: string): string {
  return command.trim().split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "") ?? "";
}

export function parsePosixProcessList(
  raw: string,
  pattern: RegExp,
  now = Date.now(),
): { alive: boolean; earliestStartedAt?: number; pid?: number } {
  let alive = false;
  let earliestStartedAt: number | undefined;
  let pid: number | undefined;
  for (const line of raw.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || !regexMatches(pattern, processCommandName(match[3]!))) continue;
    const elapsedSeconds = parseElapsedTimeSeconds(match[2]!);
    if (elapsedSeconds === undefined) continue;
    alive = true;
    const startedAt = now - elapsedSeconds * 1000;
    if (earliestStartedAt === undefined || startedAt < earliestStartedAt) {
      earliestStartedAt = startedAt;
      pid = Number(match[1]);
    }
  }
  return { alive, earliestStartedAt, pid };
}

export function matchesWindowsProcess(info: WindowsProcessInfo, rule: WindowsProcessRule): boolean {
  if (!regexMatches(rule.name, info.name)) return false;
  if (rule.path && !regexMatches(rule.path, info.path)) return false;
  if (rule.commandLine && !regexMatches(rule.commandLine, info.commandLine)) return false;
  if (rule.hasMainWindow !== undefined && rule.hasMainWindow !== info.hasMainWindow) return false;
  return true;
}

function parseWindowsProcesses(raw: string): WindowsProcessInfo[] | undefined {
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

export class ProcessLiveness {
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;
  private stopped = false;
  private lastAlive?: boolean;
  private deadStreak = 0;

  constructor(
    private readonly pattern: RegExp,
    private readonly onUpdate: ProcessLivenessSink,
    private readonly options: ProcessLivenessOptions = {},
  ) {}

  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.options.pollIntervalMs ?? POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async run(cmd: string[]): Promise<string | undefined> {
    const [executable, ...args] = cmd;
    if (!executable) return undefined;
    try {
      return await new Promise<string | undefined>((resolve) => {
        execFile(
          executable,
          args,
          {
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            timeout: SCAN_TIMEOUT_MS,
            killSignal: "SIGKILL",
          },
          (error, stdout) => resolve(error ? undefined : stdout),
        );
      });
    } catch (err) {
      log.debug(`process list failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async matches(): Promise<
    { alive: boolean; earliestStartedAt?: number; pid?: number } | undefined
  > {
    if (process.platform === "win32") {
      const rules = this.options.windowsRules ?? [{ name: this.pattern }];
      const namePredicate = rules
        .map((rule) => `$processName -match '${rule.name.source.replace(/'/g, "''")}'`)
        .join(" -or ");
      const text = await this.run([
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$items = @(Get-CimInstance Win32_Process | ForEach-Object { $processName = [System.IO.Path]::GetFileNameWithoutExtension([string]$_.Name); if (${namePredicate}) { $hasMainWindow = $false; try { $hasMainWindow = (Get-Process -Id $_.ProcessId -ErrorAction Stop).MainWindowHandle -ne 0 } catch {}; $startedAt = 0; try { $startedAt = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } catch {}; [PSCustomObject]@{ pid = [int]$_.ProcessId; name = $processName; path = [string]$_.ExecutablePath; commandLine = [string]$_.CommandLine; hasMainWindow = $hasMainWindow; startedAt = $startedAt } } }); ConvertTo-Json -InputObject @($items) -Compress`,
      ]);
      if (text === undefined) return undefined;
      const processes = parseWindowsProcesses(text);
      if (!processes) {
        log.debug("process list returned invalid JSON");
        return undefined;
      }
      let alive = false;
      let earliest: number | undefined;
      let pid: number | undefined;
      for (const info of processes) {
        if (!rules.some((rule) => matchesWindowsProcess(info, rule))) continue;
        alive = true;
        const ms = info.startedAt;
        if (Number.isFinite(ms) && ms > 0 && (earliest === undefined || ms < earliest)) {
          earliest = ms;
          pid = info.pid;
        } else if (pid === undefined) {
          pid = info.pid;
        }
      }
      return { alive, earliestStartedAt: earliest, pid };
    }

    const elapsedColumn = process.platform === "darwin" ? "etime=" : "etimes=";
    const withStart = await this.run(["ps", "-A", "-o", `pid=,${elapsedColumn},comm=`]);
    if (withStart !== undefined) {
      return parsePosixProcessList(withStart, this.pattern);
    }

    const namesOnly = await this.run(["ps", "-A", "-o", "comm="]);
    if (namesOnly === undefined) return undefined;
    const alive = namesOnly
      .split("\n")
      .some((line) => regexMatches(this.pattern, processCommandName(line)));
    return { alive };
  }

  private async scan(): Promise<void> {
    if (this.stopped || this.scanning) return;
    this.scanning = true;
    try {
      const result = await this.matches();
      if (result === undefined) return;
      if (result.alive) {
        this.deadStreak = 0;
      } else {
        this.deadStreak++;
        if (this.lastAlive === true && this.deadStreak < DEAD_CONFIRMATIONS) return;
      }
      if (result.alive !== this.lastAlive) {
        this.lastAlive = result.alive;
        log.debug(
          `processes matching ${this.pattern} alive=${result.alive}` +
            (result.earliestStartedAt !== undefined ? ` earliestStartedAt=${result.earliestStartedAt}` : "") +
            (result.pid !== undefined ? ` pid=${result.pid}` : ""),
        );
      }
      this.onUpdate(result.alive, result.earliestStartedAt, result.pid);
    } finally {
      this.scanning = false;
    }
  }
}
