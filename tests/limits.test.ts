import { test, expect } from "vitest";
import { limitsFromStatusline, limitsFromUsage, mergeLimits } from "../src/claude/limits.ts";

test("limitsFromStatusline converts epoch seconds to ms", () => {
  const limits = limitsFromStatusline(
    { five_hour: { used_percentage: 45, resets_at: 1_700_000_000 }, seven_day: { used_percentage: 0 } },
    1000,
  );
  expect(limits?.fiveHour?.usedPercentage).toBe(45);
  expect(limits?.fiveHour?.resetsAt).toBe(1_700_000_000_000);
  expect(limits?.sevenDay?.usedPercentage).toBe(0);
  expect(limits?.updatedAt).toBe(1000);
});

test("limitsFromStatusline returns undefined when empty", () => {
  expect(limitsFromStatusline(undefined, 1)).toBeUndefined();
  expect(limitsFromStatusline({}, 1)).toBeUndefined();
});

test("limitsFromUsage parses utilization and ISO reset", () => {
  const limits = limitsFromUsage(
    { five_hour: { utilization: 30, resets_at: "2026-07-08T12:00:00Z" }, seven_day: { utilization: 12 } },
    2000,
  );
  expect(limits?.fiveHour?.usedPercentage).toBe(30);
  expect(limits?.fiveHour?.resetsAt).toBe(Date.parse("2026-07-08T12:00:00Z"));
  expect(limits?.sevenDay?.usedPercentage).toBe(12);
});

test("limitsFromUsage extracts weekly_scoped model limits", () => {
  const limits = limitsFromUsage(
    {
      five_hour: { utilization: 23 },
      seven_day: { utilization: 10 },
      limits: [
        { kind: "session", percent: 23 },
        { kind: "weekly_all", percent: 10 },
        { kind: "weekly_scoped", percent: 10, scope: { model: { id: null, display_name: "Fable" } } },
      ],
    },
    5,
  );
  expect(limits?.sevenDayScoped).toEqual([{ label: "Fable", usedPercentage: 10 }]);
});

test("limitsFromUsage ignores scoped entries without a model name", () => {
  const limits = limitsFromUsage(
    { seven_day: { utilization: 10 }, limits: [{ kind: "weekly_scoped", percent: 5, scope: { model: null } }] },
    5,
  );
  expect(limits?.sevenDayScoped).toBeUndefined();
});

test("mergeLimits picks freshest window per source", () => {
  const older = limitsFromUsage({ five_hour: { utilization: 50 }, seven_day: { utilization: 10 } }, 100)!;
  const newer = limitsFromStatusline({ five_hour: { used_percentage: 60 } }, 200)!;
  const merged = mergeLimits(older, newer)!;
  expect(merged.fiveHour?.usedPercentage).toBe(60);
  expect(merged.sevenDay?.usedPercentage).toBe(10);
  expect(merged.updatedAt).toBe(200);
});

test("mergeLimits tolerates one side missing", () => {
  const a = limitsFromUsage({ five_hour: { utilization: 5 } }, 1)!;
  expect(mergeLimits(a, undefined)).toBe(a);
  expect(mergeLimits(undefined, a)).toBe(a);
  expect(mergeLimits(undefined, undefined)).toBeUndefined();
});

test("authoritative usage limits override newer placeholder statusline zeroes", () => {
  const statusline = limitsFromStatusline(
    { five_hour: { used_percentage: 0 }, seven_day: { used_percentage: 0 } },
    200,
  )!;
  const usage = limitsFromUsage(
    { five_hour: { utilization: 37 }, seven_day: { utilization: 18 } },
    100,
  )!;
  const merged = mergeLimits(statusline, usage, true)!;
  expect(merged.fiveHour?.usedPercentage).toBe(37);
  expect(merged.sevenDay?.usedPercentage).toBe(18);
});

test("invalid percentage values are ignored", () => {
  expect(limitsFromStatusline({ five_hour: { used_percentage: Number.NaN } }, 1)).toBeUndefined();
  expect(limitsFromUsage({ seven_day: { utilization: 101 } }, 1)).toBeUndefined();
});
