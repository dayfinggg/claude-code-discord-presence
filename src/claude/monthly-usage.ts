import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { MonthlyUsage, UsageTotals } from "../types.ts";
import { createLogger } from "../util/logger.ts";
import { costForUsageByModel } from "./cost.ts";

const log = createLogger("claude-monthly");
const DEFAULT_POLL_MS = 60_000;

export interface ClaudeUsageEvent {
  timestamp: string;
  model: string;
  messageId?: string;
  requestId?: string;
  sidechain: boolean;
  usage: UsageTotals;
}

export interface ClaudeMonthlyUsageRaw {
  totalTokens: number;
  usageByModel: Record<string, UsageTotals>;
  day?: ClaudeMonthlyUsageRaw;
  week?: ClaudeMonthlyUsageRaw;
  allTime?: ClaudeMonthlyUsageRaw;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  return undefined;
}

function usageTotal(usage: UsageTotals): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function parseLine(line: string): ClaudeUsageEvent | undefined {
  if (line.charCodeAt(0) !== 123 || !line.includes('"usage"')) return undefined;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const wrapped = object(object(record.data)?.message);
  const entry = wrapped && object(wrapped.message) ? wrapped : record;
  const message = object(entry.message);
  const raw = object(message?.usage);
  const at = timestamp(entry.timestamp);
  const model = message?.model;
  if (!message || !raw || !at || typeof model !== "string" || model.trim() === "") {
    return undefined;
  }

  const cacheCreation = object(raw.cache_creation);
  const oneHour = count(cacheCreation?.ephemeral_1h_input_tokens);
  const fiveMinute = count(cacheCreation?.ephemeral_5m_input_tokens);
  const usage: UsageTotals = {
    input: count(raw.input_tokens),
    output: count(raw.output_tokens),
    cacheRead: count(raw.cache_read_input_tokens),
    cacheWrite: cacheCreation ? oneHour + fiveMinute : count(raw.cache_creation_input_tokens),
  };
  if (oneHour > 0) usage.cacheWriteOneHour = Math.min(usage.cacheWrite, oneHour);
  if (usageTotal(usage) === 0) return undefined;
  return {
    timestamp: at,
    model: raw.speed === "fast" ? `${model}-fast` : model,
    messageId: typeof message.id === "string" && message.id !== "" ? message.id : undefined,
    requestId: typeof entry.requestId === "string" && entry.requestId !== "" ? entry.requestId : undefined,
    sidechain: entry.isSidechain === true,
    usage,
  };
}

async function collectJsonl(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectJsonl(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

export function claudeConfigDirs(env: Record<string, string | undefined> = process.env): string[] {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) {
    return configured
      .split(",")
      .map((path) => expandHome(path.trim()))
      .filter((path) => path !== "")
      .map((path) => (basename(path).toLowerCase() === "projects" ? dirname(path) : path));
  }
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return [join(xdg, "claude"), join(homedir(), ".claude")];
}

function dedupe(events: ClaudeUsageEvent[]): ClaudeUsageEvent[] {
  const deduped: ClaudeUsageEvent[] = [];
  const exact = new Map<string, number>();
  const byMessage = new Map<string, number[]>();
  const anonymous: ClaudeUsageEvent[] = [];
  for (const event of events) {
    if (!event.messageId) {
      anonymous.push(event);
      continue;
    }
    const exactKey = `${event.messageId}\u0000${event.requestId ?? ""}`;
    let index = exact.get(exactKey);
    if (index !== undefined && deduped[index]?.requestId !== event.requestId) index = undefined;
    if (index === undefined) {
      index = byMessage.get(event.messageId)?.find((candidate) =>
        event.sidechain || deduped[candidate]?.sidechain === true,
      );
    }
    if (index === undefined) {
      const next = deduped.length;
      deduped.push(event);
      exact.set(exactKey, next);
      const indexes = byMessage.get(event.messageId) ?? [];
      indexes.push(next);
      byMessage.set(event.messageId, indexes);
      continue;
    }
    const existing = deduped[index]!;
    const nextTotal = usageTotal(event.usage);
    const currentTotal = usageTotal(existing.usage);
    if (
      (existing.sidechain !== event.sidechain && !event.sidechain) ||
      (existing.sidechain === event.sidechain && nextTotal > currentTotal) ||
      (existing.sidechain === event.sidechain &&
        nextTotal === currentTotal &&
        event.requestId !== undefined &&
        existing.requestId === undefined)
    ) {
      deduped[index] = event;
      exact.set(exactKey, index);
    }
  }
  return [...deduped, ...anonymous];
}

export class ClaudeUsageFileCache {
  readonly entries = new Map<string, { size: number; mtimeMs: number; events: ClaudeUsageEvent[] }>();
}

function parseTranscript(text: string): ClaudeUsageEvent[] {
  const events: ClaudeUsageEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const event = parseLine(line);
    if (event) events.push(event);
  }
  return events;
}

export async function readClaudeMonthlyUsageRaw(
  configDirs = claudeConfigDirs(),
  now = new Date(),
  cache?: ClaudeUsageFileCache,
): Promise<ClaudeMonthlyUsageRaw> {
  const events: ClaudeUsageEvent[] = [];
  const liveFiles = new Set<string>();
  for (const configDir of configDirs) {
    for (const file of await collectJsonl(join(configDir, "projects"))) {
      liveFiles.add(file);
      try {
        let fileEvents: ClaudeUsageEvent[];
        if (cache) {
          const info = await stat(file);
          const entry = cache.entries.get(file);
          if (entry && entry.size === info.size && entry.mtimeMs === info.mtimeMs) {
            fileEvents = entry.events;
          } else {
            fileEvents = parseTranscript(await readFile(file, "utf8"));
            cache.entries.set(file, { size: info.size, mtimeMs: info.mtimeMs, events: fileEvents });
          }
        } else {
          fileEvents = parseTranscript(await readFile(file, "utf8"));
        }
        for (const event of fileEvents) events.push(event);
      } catch {
        // A transcript can be rotated while the scan is running; the next poll retries it.
      }
    }
  }
  if (cache) {
    for (const key of cache.entries.keys()) {
      if (!liveFiles.has(key)) cache.entries.delete(key);
    }
  }

  const unique = dedupe(events);
  const aggregate = (selected: ClaudeUsageEvent[]): ClaudeMonthlyUsageRaw => {
    const usageByModel: Record<string, UsageTotals> = {};
    let totalTokens = 0;
    for (const event of selected) {
    const bucket = (usageByModel[event.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    bucket.input += event.usage.input;
    bucket.output += event.usage.output;
    bucket.cacheRead += event.usage.cacheRead;
    bucket.cacheWrite += event.usage.cacheWrite;
    if (event.usage.cacheWriteOneHour) {
      bucket.cacheWriteOneHour = (bucket.cacheWriteOneHour ?? 0) + event.usage.cacheWriteOneHour;
    }
    totalTokens += usageTotal(event.usage);
    }
    return { totalTokens, usageByModel };
  };
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startWeek = startDay - 6 * 24 * 60 * 60 * 1000;
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const beforeTomorrow = startDay + 24 * 60 * 60 * 1000;
  const within = (start: number) => unique.filter((event) => {
    const at = Date.parse(event.timestamp);
    return at >= start && at < beforeTomorrow;
  });
  return {
    ...aggregate(within(startMonth)),
    day: aggregate(within(startDay)),
    week: aggregate(within(startWeek)),
    allTime: aggregate(unique),
  };
}

export function claudeMonthlyUsage(raw: ClaudeMonthlyUsageRaw): MonthlyUsage {
  const summary = (period: ClaudeMonthlyUsageRaw) => ({
    totalTokens: period.totalTokens,
    costUsd: costForUsageByModel(period.usageByModel).total,
  });
  return {
    ...summary(raw),
    ...(raw.day ? { day: summary(raw.day) } : {}),
    ...(raw.week ? { week: summary(raw.week) } : {}),
    ...(raw.allTime ? { allTime: summary(raw.allTime) } : {}),
  };
}

function same(a: MonthlyUsage | undefined, b: MonthlyUsage): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class ClaudeMonthlyUsageWatcher {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopped = false;
  private last?: MonthlyUsage;
  private readonly cache = new ClaudeUsageFileCache();

  constructor(
    private readonly onUpdate: (usage: MonthlyUsage) => void,
    private readonly intervalMs = DEFAULT_POLL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const usage = claudeMonthlyUsage(await readClaudeMonthlyUsageRaw(undefined, undefined, this.cache));
      if (!same(this.last, usage)) {
        this.last = usage;
        this.onUpdate(usage);
      }
    } catch (error) {
      log.warn(`monthly usage scan failed: ${(error as Error).message}`);
    } finally {
      this.polling = false;
    }
  }
}
