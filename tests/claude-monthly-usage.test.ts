import { expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeMonthlyUsage,
  readClaudeMonthlyUsageRaw,
} from "../src/claude/monthly-usage.ts";

test("Claude monthly usage parses wrappers and prefers non-sidechain duplicates", async () => {
  const config = await mkdtemp(join(tmpdir(), "claude-monthly-"));
  try {
    const project = join(config, "projects", "fixture");
    await mkdir(project, { recursive: true });
    const direct = {
      timestamp: "2026-07-15T10:00:00.000Z",
      requestId: "request-a",
      isSidechain: false,
      message: {
        id: "message-a",
        model: "claude-sonnet-4-5",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 999,
          cache_creation: {
            ephemeral_5m_input_tokens: 5,
            ephemeral_1h_input_tokens: 7,
          },
        },
      },
    };
    const sidechainCopy = {
      ...direct,
      isSidechain: true,
      message: { ...direct.message, usage: { input_tokens: 1000, output_tokens: 200 } },
    };
    const wrapped = {
      data: {
        message: {
          timestamp: "2026-07-15T11:00:00.000Z",
          requestId: "request-b",
          message: {
            id: "message-b",
            model: "claude-opus-4-6",
            usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 },
          },
        },
      },
    };
    await writeFile(
      join(project, "session.jsonl"),
      [direct, sidechainCopy, wrapped].map((value) => JSON.stringify(value)).join("\n"),
    );

    const raw = await readClaudeMonthlyUsageRaw([config], new Date("2026-07-15T12:00:00Z"));
    expect(raw.totalTokens).toBe(222);
    expect(raw.usageByModel).toEqual({
      "claude-sonnet-4-5": {
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 12,
        cacheWriteOneHour: 7,
      },
      "claude-opus-4-6": { input: 50, output: 5, cacheRead: 4, cacheWrite: 1 },
    });
    expect(claudeMonthlyUsage(raw).costUsd).toBeGreaterThan(0);
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});
