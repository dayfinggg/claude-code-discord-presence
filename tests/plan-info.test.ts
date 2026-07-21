import { test, expect } from "vitest";
import { planNameFrom } from "../src/claude/plan-info.ts";

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
