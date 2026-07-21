import { test, expect } from "vitest";
import {
  buildActivity,
  buildDetails,
  buildStateLine,
  buildHoverText,
  modelDisplayName,
  activityEquals,
} from "../src/discord/presence-builder.ts";
import type { PresenceState } from "../src/types.ts";

function base(overrides: Partial<PresenceState> = {}): PresenceState {
  return {
    planName: "Max 20X",
    action: "Editing rpc-client.ts",
    status: "working",
    planMode: false,
    agentsRunning: 0,
    agentsIdle: 0,
    model: { id: "claude-fable-5", displayName: "Fable 5" },
    effort: "xhigh",
    limits: {
      updatedAt: 1,
      fiveHour: { usedPercentage: 45 },
      sevenDay: { usedPercentage: 0 },
    },
    ...overrides,
  };
}

test("modelDisplayName maps known ids", () => {
  expect(modelDisplayName("claude-fable-5")).toBe("Fable 5");
  expect(modelDisplayName("claude-opus-4-8")).toBe("Opus 4.8");
  expect(modelDisplayName("unknown-id", "Nice Name")).toBe("Nice Name");
  expect(modelDisplayName(undefined, undefined)).toBe("Claude");
});

test("modelDisplayName normalizes CLI aliases and future model ids", () => {
  expect(modelDisplayName("claude-opus-4-8", "opus-4-8-[1m]")).toBe("Opus 4.8");
  expect(modelDisplayName("claude-opus-4-8-20260701")).toBe("Opus 4.8");
  expect(modelDisplayName("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
  expect(modelDisplayName("claude-aurora-6-2")).toBe("Aurora 6.2");
  expect(modelDisplayName("claude-aurora-6-2", "Aurora 6.2 Preview")).toBe("Aurora 6.2 Preview");
});

test("buildDetails renders plan and both windows as % left", () => {
  expect(buildDetails(base())).toBe("Max 20X • 5h 55% left • 7d 100% left");
});

test("buildDetails appends scoped model limit to the 7d segment", () => {
  const state = base({
    limits: {
      updatedAt: 1,
      fiveHour: { usedPercentage: 22 },
      sevenDay: { usedPercentage: 10 },
      sevenDayScoped: [{ label: "Fable", usedPercentage: 10 }],
    },
  });
  expect(buildDetails(state)).toBe("Max 20X • 5h 78% left • 7d 90% left (Fable 90% left)");
});

test("buildDetails shows scoped limit even without an overall 7d window", () => {
  const state = base({
    limits: { updatedAt: 1, fiveHour: { usedPercentage: 0 }, sevenDayScoped: [{ label: "Fable", usedPercentage: 40 }] },
  });
  expect(buildDetails(state)).toBe("Max 20X • 5h 100% left • 7d Fable 60% left");
});

test("buildDetails omits missing windows", () => {
  const state = base({ limits: { updatedAt: 1, fiveHour: { usedPercentage: 10 } } });
  expect(buildDetails(state)).toBe("Max 20X • 5h 90% left");
});

test("buildDetails ignores limit reset timestamps", () => {
  const now = 1_800_000_000_000;
  const state = base();
  state.limits = {
    updatedAt: now,
    fiveHour: { usedPercentage: 5, resetsAt: now + 45 * 60_000 },
    sevenDay: { usedPercentage: 10, resetsAt: now - 1 },
  };
  expect(buildDetails(state)).toBe("Max 20X • 5h 95% left • 7d 90% left");
});

test("Claude Playing activity shows limits above the current activity", () => {
  const now = Date.now();
  const state = base({
    limits: {
      updatedAt: now,
      fiveHour: { usedPercentage: 5, resetsAt: now + 2 * 60 * 60_000 },
      sevenDay: { usedPercentage: 10, resetsAt: now + (3 * 24 + 4) * 60 * 60_000 },
    },
  });
  const activity = buildActivity(state, { appName: "Claude Code" });
  expect(activity.details).toBe("Max 20X • 5h 95% left • 7d 90% left");
  expect(activity.state).toBe("Fable 5 (Extra High) • Editing rpc-client.ts");
});

test("buildDetails clamps percentage to 0..100", () => {
  const state = base({ limits: { updatedAt: 1, fiveHour: { usedPercentage: 130 } } });
  expect(buildDetails(state)).toBe("Max 20X • 5h 0% left");
});

test("buildStateLine composes model, effort, action", () => {
  expect(buildStateLine(base())).toBe("Fable 5 (Extra High) • Editing rpc-client.ts");
});

test("buildStateLine shows Thinking elapsed seconds", () => {
  expect(buildStateLine(base({ status: "thinking", action: "Thinking", thinkingSeconds: 17 }))).toBe(
    "Fable 5 (Extra High) • Thinking (17s)",
  );
});

test("buildStateLine labels every effort level", () => {
  expect(buildStateLine(base({ effort: "low" }))).toBe("Fable 5 (Light) • Editing rpc-client.ts");
  expect(buildStateLine(base({ effort: "medium" }))).toBe("Fable 5 (Medium) • Editing rpc-client.ts");
  expect(buildStateLine(base({ effort: "high" }))).toBe("Fable 5 (High) • Editing rpc-client.ts");
  expect(buildStateLine(base({ effort: "xhigh" }))).toBe("Fable 5 (Extra High) • Editing rpc-client.ts");
  expect(buildStateLine(base({ effort: "max" }))).toBe("Fable 5 (Max) • Editing rpc-client.ts");
});

test("buildStateLine appends agent chip", () => {
  expect(buildStateLine(base({ agentsRunning: 3 }))).toBe("Fable 5 (Extra High) • Editing rpc-client.ts • 3 agents running");
  expect(buildStateLine(base({ agentsRunning: 1 }))).toBe("Fable 5 (Extra High) • Editing rpc-client.ts • 1 agent running");
  expect(buildStateLine(base({ agentsRunning: 2, agentsIdle: 1 }))).toBe(
    "Fable 5 (Extra High) • Editing rpc-client.ts • 2 agents running (1 idle)",
  );
});

test("buildStateLine shows plan mode chip", () => {
  expect(buildStateLine(base({ planMode: true, action: "Idle", status: "idle" }))).toBe(
    "Fable 5 (Extra High) • Idle • Plan mode",
  );
});

test("buildStateLine shows an active goal without its name", () => {
  const line = buildStateLine(base({ goalActive: true, goalElapsedSeconds: 3_665 }));
  expect(line).toContain("Goal active (1h 1m)");
});

test("buildStateLine drops tail then truncates action when over 128 chars", () => {
  const longAction = "Editing " + "a".repeat(200) + ".ts";
  const line = buildStateLine(base({ action: longAction, agentsRunning: 5 }));
  expect(line.length).toBeLessThanOrEqual(128);
  expect(line.startsWith("Fable 5 (Extra High)")).toBe(true);
  expect(line.includes("agents running")).toBe(false);
});

test("buildStateLine preserves goal and model-adjacent Fast when the action is long", () => {
  const longAction = "Editing " + "a".repeat(200) + ".ts";
  const line = buildStateLine(base({ action: longAction, goalActive: true, goalElapsedSeconds: 3_665, fastMode: true }));
  expect(line.length).toBeLessThanOrEqual(128);
  expect(line.startsWith("Fable 5 (Extra High) Fast")).toBe(true);
  expect(line).toContain("Goal active (1h 1m)");
  expect(line).not.toContain("Fast mode");
});

test("buildStateLine without model still returns >=2 chars", () => {
  const line = buildStateLine(base({ model: undefined, effort: undefined, action: "Idle", status: "idle" }));
  expect(line).toBe("Idle");
  expect(line.length).toBeGreaterThanOrEqual(2);
});

test("buildActivity sets app name and prefers key over url", () => {
  const withKey = buildActivity(base({ startTimestamp: 1234 }), {
    appName: "Claude Code",
    largeImageKey: "claude",
    largeImageUrl: "https://cdn/icon.png",
  });
  expect(withKey.name).toBe("Claude Code");
  expect(withKey.largeImageKey).toBe("claude");
  expect(withKey.largeImageUrl).toBeUndefined();
  expect(withKey.largeImageText).toBe("Claude Code");
  expect(withKey.startTimestamp).toBe(1234);
  expect(withKey.type).toBe(0);
});

test("buildActivity falls back to image url when no key", () => {
  const withUrl = buildActivity(base(), { appName: "Claude Code", largeImageUrl: "https://cdn/icon.png" });
  expect(withUrl.largeImageKey).toBeUndefined();
  expect(withUrl.largeImageUrl).toBe("https://cdn/icon.png");
  expect(withUrl.largeImageText).toBe("Claude Code");

  const noImage = buildActivity(base(), { appName: "Claude Code" });
  expect(noImage.largeImageKey).toBeUndefined();
  expect(noImage.largeImageUrl).toBeUndefined();
});

test("buildHoverText shows per-token-type tokens and cost", () => {
  const state = base({
    usage: { input: 32_700, output: 305_900, cacheRead: 81_400_000, cacheWrite: 3_800_000 },
    costBreakdown: { input: 0.16, output: 7.65, cacheRead: 40.7, cacheWrite: 23.82, total: 72.33 },
  });
  expect(buildHoverText(state, "Claude Code")).toBe(
    "In 32.7K $0.16 • Out 305.9K $7.65 • Cache R 81.4M $40.70 • Cache W 3.8M $23.82 • Total $72.33",
  );
});

test("buildHoverText omits cache segments when zero", () => {
  const state = base({
    usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
    costBreakdown: { input: 0.005, output: 0.0125, cacheRead: 0, cacheWrite: 0, total: 0.0175 },
  });
  expect(buildHoverText(state, "Claude Code")).toBe("In 1K $0.0050 • Out 500 $0.013 • Total $0.018");
});

test("buildHoverText falls back to the app name without usage", () => {
  expect(buildHoverText(base(), "Claude Code")).toBe("Claude Code");
});

test("buildHoverText stays within 128 bytes", () => {
  const state = base({
    usage: { input: 999_000_000, output: 999_000_000, cacheRead: 999_000_000, cacheWrite: 999_000_000 },
    costBreakdown: { input: 99999.99, output: 99999.99, cacheRead: 99999.99, cacheWrite: 99999.99, total: 399999.96 },
  });
  expect(new TextEncoder().encode(buildHoverText(state, "Claude Code")).length).toBeLessThanOrEqual(128);
});

test("buildActivity puts the hover text on largeImageText", () => {
  const state = base({
    usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
    costBreakdown: { input: 0.005, output: 0.0125, cacheRead: 0, cacheWrite: 0, total: 0.0175 },
  });
  const activity = buildActivity(state, { appName: "Claude Code", largeImageUrl: "https://cdn/icon.png" });
  expect(activity.largeImageText).toBe("In 1K $0.0050 • Out 500 $0.013 • Total $0.018");
});

test("buildActivity puts day, week, month and all-time usage on the small statistics icon", () => {
  const state = base({ monthlyUsage: {
    costUsd: 2919.887,
    totalTokens: 1_838_212_224,
    day: { costUsd: 10, totalTokens: 1_200_000 },
    week: { costUsd: 80, totalTokens: 50_000_000 },
    allTime: { costUsd: 5000, totalTokens: 3_000_000_000 },
  } });
  const activity = buildActivity(state, {
    appName: "Claude Code",
    largeImageKey: "claude",
    smallImageKey: "claude-usage-stats",
  });
  expect(activity.smallImageKey).toBe("claude-usage-stats");
  expect(activity.smallImageText).toBe(
    "Day\u00a0$10·1.2M\u00a0tok\nWeek\u00a0$80·50M\u00a0tok\nMonth\u00a0$2.92K·1.8B\u00a0tok\nTotal\u00a0$5K·3B\u00a0tok",
  );
});

test("small statistics tooltip keeps large reference values compact", () => {
  const state = base({ monthlyUsage: {
    costUsd: 654.31,
    totalTokens: 677_900_000,
    day: { costUsd: 1.54, totalTokens: 1_000_000 },
    week: { costUsd: 230.69, totalTokens: 275_400_000 },
    allTime: { costUsd: 1_190, totalTokens: 1_100_000_000 },
  } });
  const text = buildActivity(state, {
    appName: "Claude Code",
    smallImageKey: "claude-usage-stats",
  }).smallImageText!;
  expect(text).toBe(
    "Day\u00a0$1.54·1M\u00a0tok\nWeek\u00a0$231·275.4M\u00a0tok\nMonth\u00a0$654·677.9M\u00a0tok\nTotal\u00a0$1.19K·1.1B\u00a0tok",
  );
  expect(text.split("\n").every((line) => !line.includes(" "))).toBe(true);
  expect(Math.max(...text.split("\n").map((line) => line.length))).toBeLessThanOrEqual(24);
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(128);
});

test("activityEquals compares all Discord-visible fields", () => {
  const assets = { appName: "Claude Code", largeImageUrl: "https://cdn/icon.png" };
  const a = buildActivity(base(), assets);
  const b = buildActivity(base(), assets);
  expect(activityEquals(a, b)).toBe(true);
  expect(activityEquals(a, { ...b, type: 3 })).toBe(false);
  expect(activityEquals(a, { ...b, statusDisplayType: 2 })).toBe(false);
  const c = buildActivity(base({ action: "Reading a.ts" }), assets);
  expect(activityEquals(a, c)).toBe(false);
});
