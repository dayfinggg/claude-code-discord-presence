import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import type { Server } from "node:http";
import { startServer } from "../src/server/http-server.ts";

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function endpoint(onHook: (payload: unknown) => void = () => undefined): Promise<string> {
  server = startServer(0, { onHook, onStatusline: () => undefined });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  expect(address.address).toBe("127.0.0.1");
  return `http://127.0.0.1:${address.port}`;
}

test("server accepts local hook objects and exposes health", async () => {
  let received: unknown;
  const url = await endpoint((payload) => { received = payload; });
  expect(await (await fetch(`${url}/health`)).text()).toBe("ok");
  const response = await fetch(`${url}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "test" }),
  });
  expect(response.status).toBe(204);
  expect(received).toMatchObject({ hook_event_name: "SessionStart", session_id: "test" });
});

test("server rejects malformed, oversized, and unknown requests", async () => {
  const url = await endpoint();
  expect((await fetch(`${url}/hook`, { method: "POST", body: "[1]" })).status).toBe(400);
  expect((await fetch(`${url}/missing`, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await fetch(`${url}/hook`, { method: "POST", body: "x".repeat(513 * 1024) })).status).toBe(413);
});
