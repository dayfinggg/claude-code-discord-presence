import { expect, test } from "vitest";
import {
  createLaunchAgentPlist,
  createSystemdUserUnit,
  type AutostartDefinition,
} from "../src/util/autostart.ts";

const definition: AutostartDefinition = {
  label: "com.example.codex-presence",
  description: "Codex Discord Presence",
  nodePath: "/Users/A & B/node",
  projectDir: "/Users/A & B/Codex % Presence",
  envFile: "/Users/A & B/Codex % Presence/.env",
  entryPoint: "/Users/A & B/Codex % Presence/dist/index.js",
};

test("launchd configuration uses argument arrays and escapes XML", () => {
  const plist = createLaunchAgentPlist(definition);
  expect(plist).toContain("/Users/A &amp; B/node");
  expect(plist).toContain("<key>ProgramArguments</key>");
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(plist).toContain("<string>/dev/null</string>");
});

test("systemd configuration safely quotes paths and disables duplicate service output", () => {
  const unit = createSystemdUserUnit(definition);
  expect(unit).toContain('WorkingDirectory="/Users/A & B/Codex %% Presence"');
  expect(unit).toContain('ExecStart="/Users/A & B/node"');
  expect(unit).toContain('"--env-file=/Users/A & B/Codex %% Presence/.env"');
  expect(unit).toContain("StandardOutput=null\nStandardError=null");
});
