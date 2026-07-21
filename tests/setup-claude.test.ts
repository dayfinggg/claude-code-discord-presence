import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("setup replaces only presence integrations and retains unrelated Claude settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-presence-"));
  temporary.push(dir);
  const backupDir = join(dir, "backups", "claude-code-presence");
  await mkdir(backupDir, { recursive: true });
  for (let i = 0; i < 7; i++) await writeFile(join(backupDir, `settings-${i}.json`), "{}");
  await writeFile(join(dir, "settings.json"), JSON.stringify({
    permissions: { allow: ["Read"] },
    statusLine: { type: "command", command: 'bun "$HOME/.claude/discord-rpc-statusline.ts"' },
    hooks: {
      SessionStart: [{ hooks: [{ type: "http", url: "http://127.0.0.1:41724/hook" }] }],
      PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "policy-check" }] }],
    },
  }));

  await execFileAsync(process.execPath, [resolve("scripts/setup-claude.mjs")], {
    cwd: resolve("."),
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    windowsHide: true,
  });

  const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
  expect(settings.permissions).toEqual({ allow: ["Read"] });
  expect(settings.statusLine.command).toMatch(/discord-presence[\\/]statusline\.mjs/);
  expect(settings.hooks.SessionStart.some((group: { hooks: Array<{ type: string }> }) =>
    group.hooks.some((hook) => hook.type === "http"))).toBe(false);
  expect(settings.hooks.SessionStart.some((group: { hooks: Array<{ type: string }> }) =>
    group.hooks.some((hook) => hook.type === "command"))).toBe(true);
  expect(settings.hooks.PreToolUse.some((group: { hooks: Array<{ command?: string }> }) =>
    group.hooks.some((hook) => hook.command === "policy-check"))).toBe(true);
  expect(settings.hooks.StopFailure.some((group: { hooks: Array<{ command?: string }> }) =>
    group.hooks.some((hook) => /discord-presence[\\/]hook\.mjs/i.test(hook.command ?? "")))).toBe(true);
  expect(await readdir(backupDir)).toHaveLength(5);
  expect(JSON.parse(await readFile(join(dir, "discord-presence", "config.json"), "utf8"))).toEqual({
    port: 41724,
    remote: false,
    installerVersion: 2,
  });
});
