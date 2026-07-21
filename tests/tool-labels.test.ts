import { test, expect } from "vitest";
import { toolLabel } from "../src/claude/tool-labels.ts";

test("Read uses basename of file_path", () => {
  expect(toolLabel("Read", { file_path: "D:/Dayfing/Discord Films/src/config.ts" })).toBe("Reading config.ts");
});

test("Read strips windows backslash paths", () => {
  expect(toolLabel("Read", { file_path: "C:\\Users\\dayfing\\secret\\notes.md" })).toBe("Reading notes.md");
});

test("Edit and NotebookEdit map to Editing", () => {
  expect(toolLabel("Edit", { file_path: "/a/b/rpc-client.ts" })).toBe("Editing rpc-client.ts");
  expect(toolLabel("NotebookEdit", { notebook_path: "/a/b/run.ipynb" })).toBe("Editing run.ipynb");
});

test("Write maps to Writing", () => {
  expect(toolLabel("Write", { file_path: "/x/index.ts" })).toBe("Writing index.ts");
});

test("search and command tools", () => {
  expect(toolLabel("Grep")).toBe("Searching files");
  expect(toolLabel("Glob")).toBe("Searching files");
  expect(toolLabel("Bash")).toBe("Running a command");
  expect(toolLabel("PowerShell")).toBe("Running a command");
});

test("mcp tool shows server name", () => {
  expect(toolLabel("mcp__github__create_issue")).toBe("Using github");
  expect(toolLabel("mcp__ccd_session__spawn_task")).toBe("Using ccd_session");
});

test("agent, web, plan, tasks", () => {
  expect(toolLabel("Agent")).toBe("Delegating to agents");
  expect(toolLabel("WebSearch")).toBe("Searching the web");
  expect(toolLabel("WebFetch")).toBe("Browsing the web");
  expect(toolLabel("EnterPlanMode")).toBe("Planning");
  expect(toolLabel("TaskCreate")).toBe("Managing tasks");
  expect(toolLabel("Workflow")).toBe("Orchestrating agents");
});

test("unknown builtin falls back to Working", () => {
  expect(toolLabel("ReportFindings")).toBe("Working");
  expect(toolLabel(undefined)).toBe("Working");
});

test("Read without a path is still safe", () => {
  expect(toolLabel("Read", {})).toBe("Reading a file");
});
