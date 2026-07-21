import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;

export function resolveLogLevel(
  env: Record<string, string | undefined> = process.env,
): LogLevel {
  const configured = env.RPC_LOG_LEVEL?.trim().toLowerCase();
  if (configured && configured in PRIORITY) return configured as LogLevel;
  return env.RPC_DEBUG === "1" || env.RPC_DEBUG?.toLowerCase() === "true" ? "debug" : "warn";
}

function resolveMaxLogBytes(): number {
  const parsed = Number.parseInt(process.env.RPC_LOG_MAX_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_LOG_BYTES;
}

const LOG_LEVEL = resolveLogLevel();
const MAX_LOG_BYTES = resolveMaxLogBytes();
let logFile: string | undefined;

export function rotateLogFile(path: string, maxBytes: number, incomingBytes = 0): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path) || statSync(path).size + incomingBytes <= maxBytes) return;
    const archive = `${path}.1`;
    rmSync(archive, { force: true });
    renameSync(path, archive);
  } catch {
    try {
      writeFileSync(path, "");
    } catch {
      /* ignore */
    }
  }
}

export function configureLogger(path: string): void {
  logFile = path;
  rotateLogFile(path, MAX_LOG_BYTES);
}

export function getLogFile(): string | undefined {
  return logFile;
}

function emit(level: Exclude<LogLevel, "silent">, scope: string, message: string, extra?: unknown): void {
  if (PRIORITY[level] < PRIORITY[LOG_LEVEL]) return;
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}`;
  const rendered = extra === undefined ? line : `${line} ${String(extra)}`;
  const stream = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  stream(rendered);
  if (!logFile) return;
  try {
    const output = `${rendered}\n`;
    rotateLogFile(logFile, MAX_LOG_BYTES, Buffer.byteLength(output));
    appendFileSync(logFile, output);
  } catch {
    /* ignore */
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, extra?: unknown) => emit("debug", scope, message, extra),
    info: (message: string, extra?: unknown) => emit("info", scope, message, extra),
    warn: (message: string, extra?: unknown) => emit("warn", scope, message, extra),
    error: (message: string, extra?: unknown) => emit("error", scope, message, extra),
  };
}
