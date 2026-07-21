import { expect, test } from "vitest";
import { join, resolve } from "node:path";
import {
  loadConfig,
  resolvePresenceDataDir,
  resolveRemoteHosts,
  type RuntimePaths,
} from "../src/config.ts";

const runtime: RuntimePaths = {
  userHome: join("C:", "Users", "example"),
  cwd: join("C:", "apps", "claude-presence"),
  platform: "win32",
};

test("configuration includes a zero-config Discord application id and accepts an override", () => {
  expect(loadConfig({}, runtime).applicationId).toMatch(/^\d+$/);
  expect(loadConfig({ CLAUDE_DISCORD_APPLICATION_ID: "app-id" }, runtime).applicationId).toBe("app-id");
});

test("data paths use per-user platform locations and support overrides", () => {
  const localAppData = join(runtime.userHome, "AppData", "Local");
  expect(resolvePresenceDataDir({ LOCALAPPDATA: localAppData }, runtime)).toBe(
    join(localAppData, "Claude Code Discord Presence"),
  );
  expect(resolvePresenceDataDir({ CLAUDE_PRESENCE_DATA_DIR: "state" }, runtime)).toBe(
    resolve(runtime.cwd, "state"),
  );
  const linux = { ...runtime, platform: "linux" as const };
  expect(resolvePresenceDataDir({ XDG_STATE_HOME: "state" }, linux)).toBe(
    join(resolve(runtime.cwd, "state"), "claude-code-discord-presence"),
  );
});

test("legacy main-service asset names remain compatible", () => {
  const config = loadConfig({
    DISCORD_APPLICATION_ID: "legacy-id",
    APP_NAME: "Claude",
    LARGE_IMAGE_KEY: "large",
    SMALL_IMAGE_KEY: "small",
  }, runtime);
  expect(config).toMatchObject({
    applicationId: "legacy-id",
    appName: "Claude",
    largeImageKey: "large",
    smallImageKey: "small",
  });
});

test("desktop session discovery can be disabled without hardcoded paths", () => {
  const config = loadConfig({
    CLAUDE_DISCORD_APPLICATION_ID: "app-id",
    CLAUDE_DESKTOP_SESSIONS_DIR: "off",
  }, runtime);
  expect(config.desktopSessionsDir).toBeUndefined();
  expect(config.logFile).toBe(join(config.dataDir, "claude-code-discord-presence.log"));
});

test("remote hosts accept only explicit safe SSH aliases", () => {
  expect(resolveRemoteHosts(undefined)).toEqual([]);
  expect(resolveRemoteHosts("off")).toEqual([]);
  expect(resolveRemoteHosts("work-box,dev_2,work-box")).toEqual(["work-box", "dev_2"]);
  expect(() => resolveRemoteHosts("-oProxyCommand=bad")).toThrow(/unsafe SSH alias/);
  expect(() => resolveRemoteHosts("user@example.com")).toThrow(/unsafe SSH alias/);
});
