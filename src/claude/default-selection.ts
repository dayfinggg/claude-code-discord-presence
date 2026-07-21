import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EffortLevel } from "../types.ts";
import { claudeConfigDir } from "./paths.ts";

const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

export interface ClaudeDefaultSelection {
  model?: string;
  effort?: EffortLevel;
}

export interface ClaudeDefaultSelectionWatcherOptions {
  settingsPath?: string;
  levelDbDir?: string;
  pollIntervalMs?: number;
}

interface Varint {
  value: number;
  next: number;
}

function readVarint(data: Uint8Array, offset: number, limit = data.length): Varint | undefined {
  let value = 0;
  let shift = 0;
  for (let i = offset; i < limit && shift <= 49; i += 1) {
    const byte = data[i]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift += 7;
  }
  return undefined;
}

function decodeSnappy(data: Uint8Array): Uint8Array | undefined {
  const expected = readVarint(data, 0);
  if (!expected || expected.value > 64 * 1024 * 1024) return undefined;
  const output = new Uint8Array(expected.value);
  let inputAt = expected.next;
  let outputAt = 0;
  while (inputAt < data.length && outputAt < output.length) {
    const tag = data[inputAt++]!;
    const type = tag & 3;
    if (type === 0) {
      let length = tag >>> 2;
      if (length < 60) {
        length += 1;
      } else {
        const bytes = length - 59;
        length = 0;
        if (inputAt + bytes > data.length) return undefined;
        for (let i = 0; i < bytes; i += 1) length += data[inputAt++]! * 2 ** (8 * i);
        length += 1;
      }
      if (inputAt + length > data.length || outputAt + length > output.length) return undefined;
      output.set(data.subarray(inputAt, inputAt + length), outputAt);
      inputAt += length;
      outputAt += length;
      continue;
    }

    const length = type === 1 ? 4 + ((tag >>> 2) & 7) : 1 + (tag >>> 2);
    let distance: number;
    if (type === 1) {
      if (inputAt >= data.length) return undefined;
      distance = ((tag & 0xe0) << 3) | data[inputAt++]!;
    } else if (type === 2) {
      if (inputAt + 2 > data.length) return undefined;
      distance = data[inputAt]! | (data[inputAt + 1]! << 8);
      inputAt += 2;
    } else {
      if (inputAt + 4 > data.length) return undefined;
      distance =
        (data[inputAt]! |
          (data[inputAt + 1]! << 8) |
          (data[inputAt + 2]! << 16) |
          (data[inputAt + 3]! << 24)) >>> 0;
      inputAt += 4;
    }
    if (distance <= 0 || distance > outputAt || outputAt + length > output.length) return undefined;
    for (let i = 0; i < length; i += 1) output[outputAt + i] = output[outputAt + i - distance]!;
    outputAt += length;
  }
  return outputAt === output.length ? output : undefined;
}

function blockHandle(data: Uint8Array, offset: number, limit = data.length): { offset: number; size: number; next: number } | undefined {
  const start = readVarint(data, offset, limit);
  if (!start) return undefined;
  const size = readVarint(data, start.next, limit);
  return size ? { offset: start.value, size: size.value, next: size.next } : undefined;
}

function readBlock(file: Uint8Array, offset: number, size: number): Uint8Array | undefined {
  if (offset < 0 || size < 0 || offset + size + 5 > file.length) return undefined;
  const body = file.subarray(offset, offset + size);
  const compression = file[offset + size];
  if (compression === 0) return body;
  return compression === 1 ? decodeSnappy(body) : undefined;
}

function blockEntries(block: Uint8Array): Array<{ key: Uint8Array; value: Uint8Array }> {
  if (block.length < 4) return [];
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const restarts = view.getUint32(block.length - 4, true);
  const limit = block.length - 4 - restarts * 4;
  if (limit < 0 || limit > block.length - 4) return [];
  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  let previous = new Uint8Array();
  let at = 0;
  while (at < limit) {
    const shared = readVarint(block, at, limit);
    if (!shared) break;
    const added = readVarint(block, shared.next, limit);
    if (!added) break;
    const valueLength = readVarint(block, added.next, limit);
    if (!valueLength || shared.value > previous.length) break;
    const keyAt = valueLength.next;
    const valueAt = keyAt + added.value;
    const next = valueAt + valueLength.value;
    if (next > limit) break;
    const key = new Uint8Array(shared.value + added.value);
    key.set(previous.subarray(0, shared.value));
    key.set(block.subarray(keyAt, valueAt), shared.value);
    const value = block.slice(valueAt, next);
    entries.push({ key, value });
    previous = key;
    at = next;
  }
  return entries;
}

function levelDbTableEntries(file: Uint8Array): Array<{ key: Uint8Array; value: Uint8Array }> {
  const footerAt = file.length - 48;
  if (footerAt < 0) return [];
  const meta = blockHandle(file, footerAt, footerAt + 40);
  const indexHandle = meta ? blockHandle(file, meta.next, footerAt + 40) : undefined;
  if (!indexHandle) return [];
  const index = readBlock(file, indexHandle.offset, indexHandle.size);
  if (!index) return [];
  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  for (const indexEntry of blockEntries(index)) {
    const handle = blockHandle(indexEntry.value, 0);
    if (!handle) continue;
    const data = readBlock(file, handle.offset, handle.size);
    if (data) entries.push(...blockEntries(data));
  }
  return entries;
}

function defaultClaudeDataDir(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming"), "Claude");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude");
  }
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "Claude");
}

export function parseClaudeDefaultModel(data: Uint8Array | string): string | undefined {
  const bytes = typeof data === "string" ? Buffer.from(data, "latin1") : data;
  const find = (text: string): string | undefined => {
    const matches = [...text.matchAll(/default-model[\s\S]{0,128}?(claude-[a-z0-9][a-z0-9._-]*)/gi)];
    return matches.at(-1)?.[1]?.toLowerCase();
  };
  const raw = find(Buffer.from(bytes).toString("latin1"));
  if (raw) return raw;
  let latest: string | undefined;
  for (const entry of levelDbTableEntries(bytes)) {
    if (!Buffer.from(entry.key).includes(Buffer.from("default-model"))) continue;
    latest = find(`default-model ${Buffer.from(entry.value).toString("latin1")}`) ?? latest;
  }
  return latest;
}

export function parseClaudeDefaultEffort(text: string): EffortLevel | undefined {
  try {
    const effort = (JSON.parse(text) as { effortLevel?: unknown }).effortLevel;
    return typeof effort === "string" && EFFORT_LEVELS.has(effort)
      ? (effort as EffortLevel)
      : undefined;
  } catch {
    return undefined;
  }
}

function sameSelection(a: ClaudeDefaultSelection | undefined, b: ClaudeDefaultSelection): boolean {
  return a?.model === b.model && a?.effort === b.effort;
}

export class ClaudeDefaultSelectionWatcher {
  private readonly settingsPath: string;
  private readonly levelDbDir: string;
  private readonly pollIntervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private current?: ClaudeDefaultSelection;

  constructor(
    options: ClaudeDefaultSelectionWatcherOptions,
    private readonly onChange: (selection: ClaudeDefaultSelection) => void,
  ) {
    const dataDir = defaultClaudeDataDir();
    this.settingsPath = options.settingsPath || join(claudeConfigDir(), "settings.json");
    this.levelDbDir = options.levelDbDir || join(dataDir, "Local Storage", "leveldb");
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
  }

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private poll(): void {
    const selection: ClaudeDefaultSelection = {
      model: this.readModel() ?? this.current?.model,
      effort: this.readEffort(),
    };
    if (sameSelection(this.current, selection)) return;
    this.current = selection;
    this.onChange(selection);
  }

  private readEffort(): EffortLevel | undefined {
    try {
      return parseClaudeDefaultEffort(readFileSync(this.settingsPath, "utf8"));
    } catch {
      return undefined;
    }
  }

  private readModel(): string | undefined {
    if (!existsSync(this.levelDbDir)) return undefined;
    try {
      const candidates = readdirSync(this.levelDbDir)
        .filter((name) => /\.(?:ldb|log)$/i.test(name))
        .map((name) => {
          const path = join(this.levelDbDir, name);
          return { path, modifiedAt: statSync(path).mtimeMs };
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
      for (const candidate of candidates) {
        const model = parseClaudeDefaultModel(readFileSync(candidate.path));
        if (model) return model;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
}
