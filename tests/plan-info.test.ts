import { test, expect } from "vitest";
import {
  planNameFrom,
  readCredentialsForPlatform,
  readMacosKeychainCredentials,
} from "../src/claude/plan-info.ts";

test("max 20x", () => {
  expect(planNameFrom("max", "default_claude_max_20x")).toBe("Max 20X");
});

test("max 5x", () => {
  expect(planNameFrom("max", "default_claude_max_5x")).toBe("Max 5X");
});

test("max without tier", () => {
  expect(planNameFrom("max", "")).toBe("Max");
});

test("pro", () => {
  expect(planNameFrom("pro", "default_claude_pro")).toBe("Pro");
});

test("unknown subscription", () => {
  expect(planNameFrom(undefined, undefined)).toBe("Claude");
  expect(planNameFrom("free", "x")).toBe("Claude");
});

test("macOS reads Claude credentials from Keychain before the file", async () => {
  const credentials = await readCredentialsForPlatform(
    "darwin",
    async () => JSON.stringify({ claudeAiOauth: { subscriptionType: "pro" } }),
    async () => JSON.stringify({
      claudeAiOauth: {
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
        accessToken: "keychain-token",
      },
    }),
  );

  expect(credentials?.claudeAiOauth?.subscriptionType).toBe("max");
  expect(credentials?.claudeAiOauth?.accessToken).toBe("keychain-token");
});

test("macOS falls back to the credentials file when Keychain is unavailable", async () => {
  const credentials = await readCredentialsForPlatform(
    "darwin",
    async () => JSON.stringify({ claudeAiOauth: { subscriptionType: "pro" } }),
    async () => undefined,
  );

  expect(credentials?.claudeAiOauth?.subscriptionType).toBe("pro");
});

test("macOS tries the current and legacy Claude Code Keychain service names", async () => {
  const calls: string[] = [];
  const raw = await readMacosKeychainCredentials(async (_file, args) => {
    const service = args[2]!;
    calls.push(service);
    if (service === "Claude Code") return { stdout: "{\"claudeAiOauth\":{}}", stderr: "" };
    throw new Error("not found");
  });

  expect(calls).toEqual(["Claude Code-credentials", "Claude Code"]);
  expect(raw).toBe("{\"claudeAiOauth\":{}}");
});
