import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseClaudeConfigTheme,
  parseClaudeThemePreference,
  parseCodexThemePreference,
  readClaudeConfigTheme,
  resolveTheme,
} from "../src/appearance/theme-watcher.ts";

test("Codex appearanceTheme is parsed from config.toml", () => {
  expect(parseCodexThemePreference('appearanceTheme = "system"\n')).toBe("system");
  expect(parseCodexThemePreference("appearanceTheme='dark' # selected in app\n")).toBe("dark");
});

test("Claude userTheme is recovered from Chromium LevelDB data", () => {
  const bytes = Buffer.from("binary\u0000userTheme\u0005light\u0000userTheme\u0004auto", "latin1");
  expect(parseClaudeThemePreference(bytes)).toBe("system");
  expect(parseClaudeThemePreference("prefix userTheme___dark suffix")).toBe("dark");
});

test("Claude Desktop config exposes theme changes immediately", () => {
  expect(parseClaudeConfigTheme('{"userThemeMode":"light"}')).toBe("light");
  expect(parseClaudeConfigTheme('{"userThemeMode":"auto"}')).toBe("system");

  const dir = mkdtempSync(join(tmpdir(), "claude-theme-"));
  const path = join(dir, "config.json");
  try {
    writeFileSync(path, '{"userThemeMode":"dark"}');
    expect(readClaudeConfigTheme(path)).toBe("dark");
    writeFileSync(path, '{"userThemeMode":"light"}');
    expect(readClaudeConfigTheme(path)).toBe("light");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit application themes override the operating system theme", () => {
  expect(resolveTheme("dark", "light")).toBe("dark");
  expect(resolveTheme("light", "dark")).toBe("light");
  expect(resolveTheme("system", "dark")).toBe("dark");
  expect(resolveTheme(undefined, "light")).toBe("light");
});
