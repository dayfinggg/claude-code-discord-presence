import { test, expect } from "vitest";
import { parseDesktopSession, sameDesktopFocus } from "../src/claude/desktop-focus.ts";

test("parses a Claude Desktop session record", () => {
  const focus = parseDesktopSession(
    JSON.stringify({
      sessionId: "local_fd94f846",
      cliSessionId: "fc8b5856-67c4-4c63-96e8-15af61c9cf58",
      cwd: "D:\\Dayfing\\Discord Films",
      lastFocusedAt: 1783525473403,
      lastActivityAt: 1783525476252,
      model: "claude-fable-5",
      effort: "high",
      isArchived: false,
    }),
  );
  expect(focus).toEqual({
    cliSessionId: "fc8b5856-67c4-4c63-96e8-15af61c9cf58",
    focusedAt: 1783525473403,
    lastActivityAt: 1783525476252,
    model: "claude-fable-5",
    effort: "high",
  });
});

test("skips archived sessions", () => {
  const focus = parseDesktopSession(
    JSON.stringify({ cliSessionId: "abc", lastFocusedAt: 1783525473403, isArchived: true }),
  );
  expect(focus).toBeUndefined();
});

test("marks sessions with a Desktop error as failed", () => {
  const focus = parseDesktopSession(
    JSON.stringify({
      cliSessionId: "failed-session",
      lastFocusedAt: 1783525473403,
      lastActivityAt: 1783525476252,
      error: "Usage credits are required for this model.",
      errorAt: 1783525476245,
    }),
  );
  expect(focus).toEqual({
    cliSessionId: "failed-session",
    focusedAt: 1783525473403,
    lastActivityAt: 1783525476252,
    failed: true,
  });
});

test("skips records without a CLI session id or focus timestamp", () => {
  expect(parseDesktopSession(JSON.stringify({ lastFocusedAt: 1783525473403 }))).toBeUndefined();
  expect(parseDesktopSession(JSON.stringify({ cliSessionId: "abc" }))).toBeUndefined();
  expect(parseDesktopSession(JSON.stringify({ cliSessionId: "abc", lastFocusedAt: 0 }))).toBeUndefined();
});

test("tolerates truncated or invalid JSON", () => {
  expect(parseDesktopSession('{"cliSessionId":"abc","lastFocus')).toBeUndefined();
  expect(parseDesktopSession("")).toBeUndefined();
  expect(parseDesktopSession("null")).toBeUndefined();
});

test("model and effort changes invalidate the same focused session", () => {
  const previous = {
    cliSessionId: "abc",
    focusedAt: 1783525473403,
    model: "claude-fable-5",
    effort: "high",
  };
  expect(sameDesktopFocus(previous, { ...previous })).toBe(true);
  expect(sameDesktopFocus(previous, { ...previous, model: "claude-opus-4-8" })).toBe(false);
  expect(sameDesktopFocus(previous, { ...previous, effort: "xhigh" })).toBe(false);
  expect(sameDesktopFocus(previous, { ...previous, failed: true })).toBe(false);
});
