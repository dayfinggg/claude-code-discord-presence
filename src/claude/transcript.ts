import { open, stat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { UsageTotals } from "../types.ts";
import { createLogger } from "../util/logger.ts";
import { claudeConfigDir } from "./paths.ts";

const log = createLogger("transcript");
const TAIL_BYTES = 262144;
const PROJECTS_DIR = join(claudeConfigDir(), "projects");

export async function findTranscriptPath(sessionId: string): Promise<string | undefined> {
  try {
    for (const dir of await readdir(PROJECTS_DIR)) {
      const candidate = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      try {
        await stat(candidate);
        return candidate;
      } catch {
        /* not in this project dir */
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export interface SessionStats {
  model?: string;
  usage: UsageTotals;
  usageByModel: Record<string, UsageTotals>;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function readSessionStats(path: string): Promise<SessionStats | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const seen = new Set<string>();
    const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const usageByModel: Record<string, UsageTotals> = {};
    let lastModel: string | undefined;

    for (const line of text.split("\n")) {
      if (line.charCodeAt(0) !== 123) continue;
      let obj: { type?: unknown; isSidechain?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type !== "assistant" || obj.isSidechain === true) continue;
      const msg = obj.message;
      const id = msg?.id;
      const model = msg?.model;
      const u = msg?.usage;
      if (typeof id !== "string" || typeof model !== "string" || !u || seen.has(id)) continue;
      seen.add(id);
      lastModel = model;
      const bucket = (usageByModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      const input = num(u.input_tokens);
      const output = num(u.output_tokens);
      const cacheRead = num(u.cache_read_input_tokens);
      const cacheWrite = num(u.cache_creation_input_tokens);
      usage.input += input;
      usage.output += output;
      usage.cacheRead += cacheRead;
      usage.cacheWrite += cacheWrite;
      bucket.input += input;
      bucket.output += output;
      bucket.cacheRead += cacheRead;
      bucket.cacheWrite += cacheWrite;
    }

    if (seen.size === 0) return undefined;
    const stats: SessionStats = { usage, usageByModel };
    if (lastModel) stats.model = lastModel;
    return stats;
  } catch (err) {
    log.debug(`session stats read failed: ${(err as Error).message}`);
    return undefined;
  }
}

export interface TranscriptModel {
  main?: string;
  mainAt?: number;
  mainEvent?: string;
  any?: string;
}

function modelCommand(content: unknown): string | undefined {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((item) => item && typeof item === "object" && "text" in item ? (item as { text?: unknown }).text : undefined)
          .filter((item): item is string => typeof item === "string")
          .join("\n")
      : "";
  const args = text.match(/<command-name>\/model<\/command-name>[\s\S]*?<command-args>([^<]+)<\/command-args>/i)?.[1]
    ?? text.match(/<local-command-stdout>\s*Set model to\s+([^<\s]+)[\s\S]*?<\/local-command-stdout>/i)?.[1];
  const model = args?.trim();
  return model?.startsWith("claude-") ? model : undefined;
}

export async function readModelFromTranscript(path: string): Promise<TranscriptModel> {
  let handle;
  try {
    const info = await stat(path);
    if (info.size === 0) return {};
    const length = Math.min(info.size, TAIL_BYTES);
    handle = await open(path, "r");
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const text = buffer.toString("utf8");

    const found: TranscriptModel = {};
    for (const line of text.split("\n")) {
      if (line.charCodeAt(0) !== 123) continue;
      let obj: {
        type?: unknown;
        subtype?: unknown;
        fallbackModel?: unknown;
        timestamp?: unknown;
        uuid?: unknown;
        requestId?: unknown;
        isSidechain?: unknown;
        message?: { model?: unknown; content?: unknown };
      };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const fallback = obj.type === "system" && obj.subtype === "model_refusal_fallback"
        ? obj.fallbackModel
        : undefined;
      const command = obj.type === "user" && obj.isSidechain !== true
        ? modelCommand(obj.message?.content)
        : undefined;
      const messageModel = obj.message?.model;
      const model = typeof fallback === "string" && fallback.startsWith("claude-")
        ? fallback
        : command
          ?? (typeof messageModel === "string" && messageModel.startsWith("claude-") ? messageModel : undefined);
      if (!model) continue;

      found.any = model;
      if (obj.isSidechain === true) continue;
      found.main = model;
      const timestamp = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : Number.NaN;
      found.mainAt = Number.isFinite(timestamp) ? timestamp : info.mtimeMs;
      found.mainEvent = [obj.timestamp, obj.uuid, obj.requestId, obj.subtype, model]
        .filter((value) => typeof value === "string" && value !== "")
        .join(":");
    }
    return found;
  } catch (err) {
    log.debug(`transcript read failed: ${(err as Error).message}`);
    return {};
  } finally {
    await handle?.close();
  }
}
