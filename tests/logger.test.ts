import { expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLogLevel, rotateLogFile } from "../src/util/logger.ts";

test("logging defaults to problems only and keeps explicit diagnostics", () => {
  expect(resolveLogLevel({})).toBe("warn");
  expect(resolveLogLevel({ RPC_DEBUG: "1" })).toBe("debug");
  expect(resolveLogLevel({ RPC_LOG_LEVEL: "error", RPC_DEBUG: "1" })).toBe("error");
});

test("log rotation keeps a single bounded archive", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-presence-log-"));
  const file = join(dir, "service.log");
  try {
    writeFileSync(file, "previous");
    writeFileSync(`${file}.1`, "older");
    rotateLogFile(file, 8, 1);

    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("previous");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
