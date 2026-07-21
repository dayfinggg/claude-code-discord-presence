import { expect, test } from "vitest";
import { isSafeSshAlias, remoteForwardArguments } from "../src/remote/tunnel-manager.ts";

test("reverse tunnel binds both ends to loopback and uses a validated alias", () => {
  expect(remoteForwardArguments("work-box_2", 41724, 41725)).toEqual([
    "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-R", "127.0.0.1:41725:127.0.0.1:41724",
    "work-box_2",
  ]);
});

test("SSH aliases reject options, destinations, whitespace, and shell syntax", () => {
  expect(isSafeSshAlias("production-box")).toBe(true);
  for (const value of ["-v", "user@example.com", "host name", "host;command", "127.0.0.1:22"]) {
    expect(isSafeSshAlias(value)).toBe(false);
    expect(() => remoteForwardArguments(value, 41724, 41724)).toThrow(/Unsafe SSH alias/);
  }
});
