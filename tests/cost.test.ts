import { test, expect } from "vitest";
import { costUsd, costBreakdown, normalizeModelId } from "../src/claude/cost.ts";

test("costBreakdown splits cost per token type", () => {
  const b = costBreakdown("claude-opus-4-8", { input: 100_000, output: 50_000, cacheRead: 1_000_000, cacheWrite: 200_000 });
  expect(b.input).toBeCloseTo(0.5, 6);
  expect(b.output).toBeCloseTo(1.25, 6);
  expect(b.cacheRead).toBeCloseTo(0.5, 6);
  expect(b.cacheWrite).toBeCloseTo(1.25, 6);
  expect(b.total).toBeCloseTo(3.5, 6);
});

test("normalizeModelId strips date suffix", () => {
  expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  expect(normalizeModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
});

test("costUsd prices opus 4.8 per component", () => {
  const cost = costUsd("claude-opus-4-8", { input: 100_000, output: 50_000, cacheRead: 1_000_000, cacheWrite: 200_000 });
  expect(cost).toBeCloseTo(3.5, 6);
});

test("costUsd prices sonnet 5 intro rate", () => {
  expect(costUsd("claude-sonnet-5", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(12, 6);
});

test("costUsd works with a date-suffixed model id", () => {
  expect(costUsd("claude-haiku-4-5-20251001", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(1, 6);
});

test("costUsd is zero for an unknown model", () => {
  expect(costUsd("gpt-5", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBe(0);
});
