import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeDefaultSelectionWatcher,
  parseClaudeDefaultEffort,
  parseClaudeDefaultModel,
} from "../src/claude/default-selection.ts";

test("Claude's current default model is recovered from Chromium LevelDB data", () => {
  const bytes = Buffer.from(
    "old\0default-model\0claude-fable-5\0new\0default-model\0claude-opus-4-8",
    "latin1",
  );
  expect(parseClaudeDefaultModel(bytes)).toBe("claude-opus-4-8");
});

test("Claude's current effort is recovered from settings", () => {
  expect(parseClaudeDefaultEffort('{"effortLevel":"xhigh"}')).toBe("xhigh");
  expect(parseClaudeDefaultEffort('{"effortLevel":"ultra"}')).toBe("ultra");
  expect(parseClaudeDefaultEffort('{"effortLevel":"invalid"}')).toBeUndefined();
});

test("default selection watcher reports model and effort changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-default-selection-"));
  const levelDbDir = join(dir, "leveldb");
  const settingsPath = join(dir, "settings.json");
  mkdirSync(levelDbDir);
  writeFileSync(join(levelDbDir, "000001.log"), "default-model\0claude-fable-5", "latin1");
  writeFileSync(settingsPath, '{"effortLevel":"low"}', "utf8");
  const seen: Array<{ model?: string; effort?: string }> = [];
  const watcher = new ClaudeDefaultSelectionWatcher(
    { levelDbDir, settingsPath, pollIntervalMs: 20 },
    (selection) => seen.push(selection),
  );
  try {
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    writeFileSync(join(levelDbDir, "000002.log"), "default-model\0claude-opus-4-8", "latin1");
    writeFileSync(settingsPath, '{"effortLevel":"xhigh"}', "utf8");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen.at(-1)).toEqual({ model: "claude-opus-4-8", effort: "xhigh" });
  } finally {
    watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
