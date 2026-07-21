import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionStats, readModelFromTranscript } from "../src/claude/transcript.ts";

function assistantLine(id: string, model: string, usage: Record<string, number>, sidechain = false): string {
  return JSON.stringify({ type: "assistant", isSidechain: sidechain, message: { id, model, usage } });
}

test("session stats split usage by model across a model switch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rpc-transcript-"));
  const path = join(dir, "session.jsonl");
  const lines = [
    assistantLine("m1", "claude-opus-4-8", { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 }),
    assistantLine("m2", "claude-fable-5", { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 }),
    assistantLine("m2", "claude-fable-5", { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 2 }),
    assistantLine("m3", "claude-haiku-4-5", { input_tokens: 999, output_tokens: 999 }, true),
  ];
  await writeFile(path, lines.join("\n") + "\n", "utf8");

  const stats = await readSessionStats(path);
  expect(stats?.model).toBe("claude-fable-5");
  expect(stats?.usage).toEqual({ input: 300, output: 30, cacheRead: 15, cacheWrite: 3 });
  expect(stats?.usageByModel).toEqual({
    "claude-opus-4-8": { input: 100, output: 10, cacheRead: 5, cacheWrite: 1 },
    "claude-fable-5": { input: 200, output: 20, cacheRead: 10, cacheWrite: 2 },
  });

  await rm(dir, { recursive: true, force: true });
});

test("the transcript model prefers the main chain over sidechain entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rpc-transcript-"));
  const path = join(dir, "session.jsonl");
  const lines = [
    assistantLine("m1", "claude-fable-5", { input_tokens: 1, output_tokens: 1 }),
    assistantLine("m2", "claude-haiku-4-5", { input_tokens: 1, output_tokens: 1 }, true),
  ];
  await writeFile(path, lines.join("\n") + "\n", "utf8");

  const found = await readModelFromTranscript(path);
  expect(found.main).toBe("claude-fable-5");
  expect(found.any).toBe("claude-haiku-4-5");

  await rm(dir, { recursive: true, force: true });
});

test("a Fable refusal fallback changes the effective model before the next assistant message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rpc-transcript-"));
  const path = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-16T09:34:09.331Z",
      isSidechain: false,
      message: { id: "m1", model: "claude-fable-5", usage: { input_tokens: 1, output_tokens: 1 } },
    }),
    JSON.stringify({
      type: "system",
      subtype: "model_refusal_fallback",
      fallbackModel: "claude-opus-4-8",
      timestamp: "2026-07-16T09:34:42.949Z",
    }),
  ];
  await writeFile(path, lines.join("\n") + "\n", "utf8");

  const found = await readModelFromTranscript(path);
  expect(found.main).toBe("claude-opus-4-8");
  expect(found.mainAt).toBe(Date.parse("2026-07-16T09:34:42.949Z"));
  expect(found.mainEvent).toContain("model_refusal_fallback");

  await rm(dir, { recursive: true, force: true });
});

test("a later model command replaces an earlier fallback before a prompt is sent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rpc-transcript-"));
  const path = join(dir, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "system",
      subtype: "model_refusal_fallback",
      fallbackModel: "claude-opus-4-8",
      timestamp: "2026-07-16T09:20:00.000Z",
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-16T09:27:20.211Z",
      isSidechain: false,
      message: {
        content: "<command-name>/model</command-name><command-message>model</command-message><command-args>claude-fable-5</command-args>",
      },
    }),
  ];
  await writeFile(path, lines.join("\n") + "\n", "utf8");

  const found = await readModelFromTranscript(path);
  expect(found.main).toBe("claude-fable-5");
  expect(found.mainAt).toBe(Date.parse("2026-07-16T09:27:20.211Z"));

  await rm(dir, { recursive: true, force: true });
});
