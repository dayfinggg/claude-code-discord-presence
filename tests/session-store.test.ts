import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/claude/session-store.ts";
import type { HookPayload } from "../src/types.ts";

function newStore(): SessionStore {
  return new SessionStore(() => {}, { focusDebounceMs: 0 });
}

const hook = (p: HookPayload): HookPayload => p;

test("a switched-to session never shows the previous session's model", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "A", model: "claude-opus-4-8" }));
  store.handleHook(hook({ hook_event_name: "PreToolUse", session_id: "A", tool_name: "Edit", tool_input: { file_path: "/x/a.ts" } }));
  expect(store.snapshot()?.action).toBe("Editing a.ts");

  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "B" }));
  const snap = store.snapshot();
  expect(snap?.action).toBe("Waiting for a prompt");
  expect(snap?.model).toBeUndefined();

  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "B", model: "claude-sonnet-5" }));
  expect(store.snapshot()?.model?.displayName).toBe("Sonnet 5");
  store.dispose();
});

test("effort falls back to the configured default when the session has none", () => {
  const store = newStore();
  store.setDefaultEffort("xhigh");
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "A", model: "claude-opus-4-8" }));
  expect(store.snapshot()?.effort).toBe("xhigh");

  store.handleHook(hook({ hook_event_name: "PreToolUse", session_id: "A", tool_name: "Bash", effort: { level: "high" } }));
  expect(store.snapshot()?.effort).toBe("high");
  store.dispose();
});

test("Claude snapshots do not expose Codex Goal state", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "A" }));
  expect(store.snapshot()?.goalActive).toBeUndefined();
  expect(store.snapshot()?.goalElapsedSeconds).toBeUndefined();
  store.dispose();
});

test("an ephemeral session that ends immediately never takes focus (debounced)", async () => {
  const store = new SessionStore(() => {}, { focusDebounceMs: 40 });
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "A", model: "claude-opus-4-8" }));
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "A" }));
  expect(store.snapshot()?.model?.displayName).toBe("Opus 4.8");

  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "ephemeral" }));
  store.handleHook(hook({ hook_event_name: "SessionEnd", session_id: "ephemeral" }));
  await new Promise((r) => setTimeout(r, 80));
  expect(store.snapshot()?.model?.displayName).toBe("Opus 4.8");
  store.dispose();
});

test("background tool activity in another session does not steal focus", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "A", model: "claude-opus-4-8" }));
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "B", model: "claude-sonnet-5" }));
  expect(store.snapshot()?.model?.displayName).toBe("Sonnet 5");

  store.handleHook(hook({ hook_event_name: "PreToolUse", session_id: "A", tool_name: "Bash" }));
  store.handleHook(hook({ hook_event_name: "PostToolUse", session_id: "A", tool_name: "Bash" }));
  expect(store.snapshot()?.model?.displayName).toBe("Sonnet 5");
  expect(store.snapshot()?.action).toBe("Waiting for a prompt");
  store.dispose();
});

test("submitting a prompt in another session moves focus there", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "A", model: "claude-opus-4-8" }));
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "B", model: "claude-sonnet-5" }));
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "A" }));
  const snap = store.snapshot();
  expect(snap?.model?.displayName).toBe("Opus 4.8");
  expect(snap?.action).toBe("Thinking");
  store.dispose();
});

test("ending the focused session falls back to the other session", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "A", model: "claude-opus-4-8" }));
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "A" }));
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "B", model: "claude-sonnet-5" }));
  store.handleHook(hook({ hook_event_name: "SessionEnd", session_id: "B" }));
  expect(store.snapshot()?.model?.displayName).toBe("Opus 4.8");
  store.dispose();
});

test("the elapsed timer stays stable across a session switch", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "A", model: "claude-opus-4-8" }));
  const t1 = store.snapshot()?.startTimestamp;
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "A" }));
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "B", model: "claude-sonnet-5" }));
  const t2 = store.snapshot()?.startTimestamp;
  expect(t1).toBeGreaterThan(0);
  expect(t2).toBe(t1);
  store.dispose();
});

test("ending the only session clears the presence", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "A", model: "claude-opus-4-8" }));
  store.handleHook(hook({ hook_event_name: "SessionEnd", session_id: "A" }));
  expect(store.snapshot()).toBeUndefined();
  store.dispose();
});

test("selecting another session in Claude Desktop moves the presence there", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "A", model: "claude-opus-4-8" }));
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "B", model: "claude-sonnet-5" }));
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "A" }));
  expect(store.snapshot()?.model?.displayName).toBe("Opus 4.8");

  store.setDesktopFocus("B", { focusedAt: Date.now() });
  expect(store.snapshot()?.model?.displayName).toBe("Sonnet 5");
  store.dispose();
});

test("desktop focus on a session with no hook events yet still shows it", () => {
  const store = newStore();
  store.setDesktopFocus("C", { focusedAt: Date.now(), model: "claude-fable-5", effort: "high" });
  const snap = store.snapshot();
  expect(snap?.model?.displayName).toBe("Fable 5");
  expect(snap?.effort).toBe("high");
  expect(snap?.action).toBe("Idle");
  store.dispose();
});

test("an empty Desktop session uses the selections currently shown in the composer", () => {
  const store = newStore();
  store.setDefaultModel("claude-opus-4-8");
  store.setDefaultEffort("xhigh");
  store.setDesktopFocus("C", {
    focusedAt: Date.now(),
    model: "claude-fable-5",
    effort: "low",
  });

  const snap = store.snapshot();
  expect(snap?.model?.displayName).toBe("Opus 4.8");
  expect(snap?.effort).toBe("xhigh");
  store.dispose();
});

test("the first hook replaces stale Desktop metadata for a previously empty session", () => {
  const store = newStore();
  store.setDesktopFocus("C", {
    focusedAt: Date.now(),
    model: "claude-fable-5",
    effort: "low",
  });
  store.handleHook(hook({
    hook_event_name: "UserPromptSubmit",
    session_id: "C",
    model: "claude-opus-4-8",
    effort: { level: "xhigh" },
  }));

  const snap = store.snapshot();
  expect(snap?.model?.displayName).toBe("Opus 4.8");
  expect(snap?.effort).toBe("xhigh");
  store.dispose();
});

test("a failed Desktop session is discarded instead of staying in Thinking", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "healthy", model: "claude-opus-4-8" }));
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "failed", model: "claude-fable-5" }));
  expect(store.snapshot()?.action).toBe("Thinking");

  store.setDesktopFocus("failed", { focusedAt: Date.now(), failed: true });

  const snap = store.snapshot();
  expect(snap?.model?.displayName).toBe("Opus 4.8");
  expect(snap?.action).toBe("Waiting for a prompt");
  store.dispose();
});

test("a stale desktop focus does not override a session used afterwards", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "A", model: "claude-opus-4-8" }));
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "A" }));
  store.setDesktopFocus("B", { focusedAt: Date.now() - 60_000, model: "claude-sonnet-5" });
  expect(store.snapshot()?.model?.displayName).toBe("Opus 4.8");
  store.dispose();
});

test("a stale desktop focus alone does not resurrect an idle session", () => {
  const store = newStore();
  store.setDesktopFocus("old", { focusedAt: Date.now() - 60 * 60 * 1000, model: "claude-fable-5" });
  expect(store.snapshot()).toBeUndefined();
  store.dispose();
});

test("subagent tool events do not override effort, model, or the main action", () => {
  const store = newStore();
  store.handleHook(
    hook({
      hook_event_name: "UserPromptSubmit",
      session_id: "A",
      model: "claude-fable-5",
      effort: { level: "xhigh" },
    }),
  );
  store.handleHook(hook({ hook_event_name: "PreToolUse", session_id: "A", tool_name: "Agent", effort: { level: "xhigh" } }));
  store.handleHook(hook({ hook_event_name: "SubagentStart", session_id: "A", agent_id: "g1", agent_type: "explore" }));
  store.handleHook(
    hook({
      hook_event_name: "PreToolUse",
      session_id: "A",
      agent_id: "g1",
      tool_name: "Read",
      tool_input: { file_path: "/x/probe.ts" },
      effort: { level: "low" },
      model: "claude-haiku-4-5",
    }),
  );

  const snap = store.snapshot();
  expect(snap?.effort).toBe("xhigh");
  expect(snap?.model?.displayName).toBe("Fable 5");
  expect(snap?.action).toBe("Delegating to agents");
  expect(snap?.agentsRunning).toBe(1);

  store.handleHook(
    hook({ hook_event_name: "SubagentStop", session_id: "A", agent_id: "g1", agent_type: "explore", effort: { level: "low" } }),
  );
  const after = store.snapshot();
  expect(after?.effort).toBe("xhigh");
  expect(after?.agentsRunning).toBe(0);
  store.dispose();
});

test("idle session with agents still running shows waiting for agents", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "A", model: "claude-fable-5" }));
  store.handleHook(hook({ hook_event_name: "SubagentStart", session_id: "A", agent_id: "g1", agent_type: "executor" }));
  store.handleHook(hook({ hook_event_name: "Stop", session_id: "A" }));
  const snap = store.snapshot();
  expect(snap?.action).toBe("Waiting for agents");
  expect(snap?.agentsRunning).toBe(1);

  store.handleHook(hook({ hook_event_name: "SubagentStop", session_id: "A", agent_id: "g1", agent_type: "executor" }));
  expect(store.snapshot()?.action).toBe("Idle");
  store.dispose();
});

test("a subagent tool event re-registers a running agent after a restart", () => {
  const store = newStore();
  store.handleHook(
    hook({ hook_event_name: "PreToolUse", session_id: "A", agent_id: "g1", tool_name: "Read", effort: { level: "low" } }),
  );
  const snap = store.snapshot();
  expect(snap?.agentsRunning).toBe(1);
  expect(snap?.action).toBe("Waiting for agents");
  expect(snap?.effort).toBeUndefined();
  store.dispose();
});

test("cost is priced per model after a mid-session model switch", () => {
  const store = newStore();
  store.handleHook(
    hook({
      hook_event_name: "UserPromptSubmit",
      session_id: "A",
      model: "claude-fable-5",
      usage: { input_tokens: 2_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      usage_by_model: {
        "claude-opus-4-8": { input_tokens: 1_000_000, output_tokens: 500_000 },
        "claude-fable-5": { input_tokens: 1_000_000, output_tokens: 500_000 },
      },
    }),
  );
  const snap = store.snapshot();
  expect(snap?.usage).toEqual({ input: 2_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
  expect(snap?.costUsd).toBeCloseTo(52.5, 6);
  store.dispose();
});

test("statusline context usage does not overwrite cumulative session totals", () => {
  const store = newStore();
  store.handleHook(
    hook({
      hook_event_name: "UserPromptSubmit",
      session_id: "A",
      model: "claude-fable-5",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
  );
  store.handleStatusline({ session_id: "A", context_window: { current_usage: { input_tokens: 1, output_tokens: 2 } } });
  expect(store.snapshot()?.usage).toEqual({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 });
  store.dispose();
});

test("statusline usage still fills in when nothing else is known", () => {
  const store = newStore();
  store.handleStatusline({
    session_id: "A",
    model: { id: "claude-fable-5", display_name: "Fable 5" },
    context_window: { current_usage: { input_tokens: 10, output_tokens: 5 } },
  });
  expect(store.snapshot()?.usage).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  store.dispose();
});

test("statusline Fast mode is reflected in the Claude snapshot", () => {
  const store = newStore();
  store.handleStatusline({
    session_id: "A",
    model: { id: "claude-fable-5", display_name: "Fable 5" },
    fast_mode: true,
  });
  expect(store.snapshot()?.fastMode).toBe(true);

  store.handleStatusline({ session_id: "A", fast_mode: false });
  expect(store.snapshot()?.fastMode).toBe(false);
  store.dispose();
});

test("an API StopFailure ends Thinking immediately", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "A" }));
  expect(store.snapshot()?.status).toBe("thinking");
  expect(store.snapshot()?.thinkingSeconds).toBeDefined();

  store.handleHook(hook({
    hook_event_name: "StopFailure",
    session_id: "A",
    error: "authentication_failed",
    error_details: "401 Unauthorized",
  }));

  expect(store.snapshot()?.status).toBe("idle");
  expect(store.snapshot()?.action).toBe("Idle");
  expect(store.snapshot()?.thinkingSeconds).toBeUndefined();
  store.dispose();
});

test("presence persists as Idle after long inactivity while Claude Code is still running", () => {
  const store = newStore();
  store.setAppLiveness(true, Date.now() - 3 * 60 * 60 * 1000);
  store.setDesktopFocus("old", { focusedAt: Date.now() - 60 * 60 * 1000, model: "claude-fable-5" });
  const snap = store.snapshot();
  expect(snap?.status).toBe("idle");
  expect(snap?.action).toBe("Idle");
  expect(snap?.model?.displayName).toBe("Fable 5");
  expect(snap?.agentsRunning).toBe(0);

  store.setAppLiveness(false);
  expect(store.snapshot()).toBeUndefined();
  store.dispose();
});

test("the elapsed timer anchors to app start and survives session switches", () => {
  const store = newStore();
  const appStart = Date.now() - 90 * 60 * 1000;
  store.setAppLiveness(true, appStart);
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "A", model: "claude-fable-5" }));
  expect(store.snapshot()?.startTimestamp).toBe(appStart);
  store.handleHook(hook({ hook_event_name: "SessionStart", session_id: "B" }));
  expect(store.snapshot()?.startTimestamp).toBe(appStart);
  store.dispose();
});

test("a late liveness report moves the elapsed anchor back to app start", () => {
  const store = newStore();
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "A", model: "claude-fable-5" }));
  const first = store.snapshot()!.startTimestamp!;
  const appStart = first - 60 * 60 * 1000;
  store.setAppLiveness(true, appStart);
  expect(store.snapshot()?.startTimestamp).toBe(appStart);
  store.dispose();
});

test("closing Claude Code hides a fresh local session immediately", () => {
  const store = newStore();
  const appStart = Date.now() - 10 * 60 * 1000;
  store.setAppLiveness(true, appStart);
  store.setDesktopFocus("A", { focusedAt: Date.now(), model: "claude-fable-5" });
  expect(store.snapshot()?.startTimestamp).toBe(appStart);

  store.setAppLiveness(false);
  expect(store.snapshot()).toBeUndefined();
  store.dispose();
});

test("the first closed report hides a local session discovered during startup", () => {
  const store = newStore();
  store.setDesktopFocus("A", { focusedAt: Date.now(), model: "claude-fable-5" });
  expect(store.snapshot()).toBeDefined();

  store.setAppLiveness(false);
  expect(store.snapshot()).toBeUndefined();
  store.dispose();
});

test("restarting Claude Code resets the elapsed timer to the new app start", () => {
  const store = newStore();
  const firstStart = Date.now() - 2 * 60 * 60 * 1000;
  store.setAppLiveness(true, firstStart);
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "A", model: "claude-fable-5" }));
  expect(store.snapshot()?.startTimestamp).toBe(firstStart);

  store.setAppLiveness(false);
  const secondStart = Date.now() - 30_000;
  store.setAppLiveness(true, secondStart);
  expect(store.snapshot()?.startTimestamp).toBe(secondStart);
  store.dispose();
});

test("after an idle clear the elapsed timer re-anchors to the session start, not to now", async () => {
  const store = new SessionStore(() => {}, { focusDebounceMs: 0, appCloseGraceMs: 20 });
  store.handleHook(hook({ hook_event_name: "UserPromptSubmit", session_id: "A", model: "claude-fable-5" }));
  await new Promise((r) => setTimeout(r, 60));
  expect(store.snapshot()).toBeUndefined();

  const bStart = Date.now() - 60_000;
  store.setDesktopFocus("B", { focusedAt: Date.now(), lastActivityAt: bStart, model: "claude-sonnet-5" });
  expect(store.snapshot()?.startTimestamp).toBe(bStart);
  store.dispose();
});

test("a remote session outlives local app closure while a local one does not", async () => {
  const store = new SessionStore(() => {}, { focusDebounceMs: 0, appCloseGraceMs: 10 });
  store.handleHook(
    hook({
      hook_event_name: "UserPromptSubmit",
      session_id: "R",
      model: "claude-opus-4-8",
      transcript_path: "/home/user/.claude/projects/x/R.jsonl",
      remote: true,
    }),
  );
  store.handleHook(
    hook({
      hook_event_name: "UserPromptSubmit",
      session_id: "L",
      model: "claude-sonnet-5",
      transcript_path: "C:\\Users\\x\\.claude\\projects\\y\\L.jsonl",
    }),
  );
  await new Promise((r) => setTimeout(r, 40));
  expect(store.snapshot()?.model?.displayName).toBe("Opus 4.8");
  store.dispose();
});

test("desktop model and effort changes replace values from the previous request", () => {
  const store = newStore();
  store.handleHook(
    hook({
      hook_event_name: "UserPromptSubmit",
      session_id: "A",
      model: "claude-opus-4-8",
      effort: { level: "xhigh" },
    }),
  );
  store.setDesktopFocus("A", { focusedAt: Date.now(), model: "claude-sonnet-5", effort: "low" });
  const snap = store.snapshot();
  expect(snap?.model?.displayName).toBe("Sonnet 5");
  expect(snap?.effort).toBe("low");
  store.dispose();
});

test("a transcript fallback stays authoritative over stale hooks until the selected model changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rpc-session-store-"));
  const path = join(dir, "session.jsonl");
  const fallbackAt = Date.now() + 50;
  await writeFile(
    path,
    [
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(fallbackAt - 1_000).toISOString(),
        message: { id: "before-fallback", model: "claude-fable-5", usage: {} },
      }),
      JSON.stringify({
        type: "system",
        subtype: "model_refusal_fallback",
        fallbackModel: "claude-opus-4-8",
        timestamp: new Date(fallbackAt).toISOString(),
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const store = new SessionStore(() => {}, { focusDebounceMs: 0, modelPollIntervalMs: 25 });
  store.handleHook(hook({
    hook_event_name: "UserPromptSubmit",
    session_id: "A",
    transcript_path: path,
    model: "claude-fable-5",
  }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(store.snapshot()?.model?.displayName).toBe("Opus 4.8");

  store.handleHook(hook({ hook_event_name: "PreToolUse", session_id: "A", model: "claude-fable-5", tool_name: "Read" }));
  expect(store.snapshot()?.model?.displayName).toBe("Opus 4.8");

  store.setDesktopFocus("A", {
    focusedAt: Date.now(),
    updatedAt: fallbackAt + 1_000,
    model: "claude-sonnet-5",
  });
  expect(store.snapshot()?.model?.displayName).toBe("Sonnet 5");

  store.dispose();
  await rm(dir, { recursive: true, force: true });
});
