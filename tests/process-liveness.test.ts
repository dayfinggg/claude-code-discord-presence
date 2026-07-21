import { expect, test } from "vitest";
import {
  CLAUDE_WINDOWS_PROCESS_RULES,
  CODEX_WINDOWS_PROCESS_RULES,
  matchesWindowsProcess,
  parseElapsedTimeSeconds,
  parsePosixProcessList,
  type WindowsProcessInfo,
  type WindowsProcessRule,
} from "../src/util/process-liveness.ts";

function matches(info: WindowsProcessInfo, rules: readonly WindowsProcessRule[]): boolean {
  return rules.some((rule) => matchesWindowsProcess(info, rule));
}

function processInfo(overrides: Partial<WindowsProcessInfo>): WindowsProcessInfo {
  return {
    pid: 1234,
    name: "codex",
    path: "",
    commandLine: "",
    hasMainWindow: false,
    startedAt: Date.now(),
    ...overrides,
  };
}

test("Codex ignores plugin app-server processes", () => {
  const plugin = processInfo({
    path: "C:\\Users\\example\\.codex\\plugins\\.plugin-appserver\\codex.exe",
    commandLine: '"C:\\Users\\example\\.codex\\plugins\\.plugin-appserver\\codex.exe" app-server',
  });
  expect(matches(plugin, CODEX_WINDOWS_PROCESS_RULES)).toBe(false);
});

test("Codex Desktop requires the package main window", () => {
  const main = processInfo({
    name: "ChatGPT",
    path: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\ChatGPT.exe",
    commandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0_x64\\app\\ChatGPT.exe"',
    hasMainWindow: true,
  });
  expect(matches(main, CODEX_WINDOWS_PROCESS_RULES)).toBe(true);
  expect(matches({ ...main, hasMainWindow: false }, CODEX_WINDOWS_PROCESS_RULES)).toBe(false);
});

test("Codex CLI remains a valid live process", () => {
  const cli = processInfo({
    path: "C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\codex.exe",
    commandLine: '"C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\codex.exe"',
  });
  expect(matches(cli, CODEX_WINDOWS_PROCESS_RULES)).toBe(true);
});

test("Claude Desktop requires the package main window while Claude CLI stays valid", () => {
  const desktop = processInfo({
    name: "claude",
    path: "C:\\Program Files\\WindowsApps\\Claude_1.0_x64\\app\\claude.exe",
    commandLine: '"C:\\Program Files\\WindowsApps\\Claude_1.0_x64\\app\\claude.exe"',
    hasMainWindow: true,
  });
  const cli = processInfo({
    name: "claude",
    path: "C:\\Users\\example\\.local\\bin\\claude.exe",
    commandLine: '"C:\\Users\\example\\.local\\bin\\claude.exe"',
  });
  expect(matches(desktop, CLAUDE_WINDOWS_PROCESS_RULES)).toBe(true);
  expect(matches({ ...desktop, hasMainWindow: false }, CLAUDE_WINDOWS_PROCESS_RULES)).toBe(false);
  expect(matches(cli, CLAUDE_WINDOWS_PROCESS_RULES)).toBe(true);
});

test("POSIX elapsed time supports Linux and macOS process output", () => {
  expect(parseElapsedTimeSeconds("125")).toBe(125);
  expect(parseElapsedTimeSeconds("01:02:05")).toBe(3_725);
  expect(parseElapsedTimeSeconds("2-01:02:05")).toBe(176_525);
});

test("POSIX process parsing recognizes Claude CLI and Desktop executable paths", () => {
  const now = 2_000_000;
  expect(parsePosixProcessList("101 20 /usr/local/bin/claude\n", /^claude$/i, now)).toEqual({
    alive: true,
    earliestStartedAt: now - 20_000,
    pid: 101,
  });
  expect(parsePosixProcessList("202 01:00 /Applications/Claude.app/Contents/MacOS/claude\n", /^claude$/i, now)).toEqual({
    alive: true,
    earliestStartedAt: now - 60_000,
    pid: 202,
  });
});
