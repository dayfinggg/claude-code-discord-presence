import { expect, test } from "vitest";
import { RpcClient, type RpcClientTransport } from "../src/discord/rpc-client.ts";
import type { Activity } from "../src/discord/presence-builder.ts";

class FakeTransport implements RpcClientTransport {
  readonly listeners = new Map<"ready" | "disconnected", Array<() => void>>();
  clearCalls = 0;
  clearPids: number[] = [];
  setCalls: Array<{ activity: Activity; pid?: number }> = [];
  loginCalls = 0;
  destroyCalls = 0;
  readonly user = {
    setActivity: async (activity: Activity, pid?: number): Promise<void> => {
      this.setCalls.push({ activity, pid });
    },
  };

  async request(_command: "SET_ACTIVITY", args: { pid: number }): Promise<void> {
    this.clearCalls += 1;
    this.clearPids.push(args.pid);
  }

  on(event: "ready" | "disconnected", listener: () => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  async login(): Promise<void> {
    this.loginCalls += 1;
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
  }

  emit(event: "ready" | "disconnected"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

test("a new Discord connection clears an unknown stale activity", async () => {
  const transport = new FakeTransport();
  const rpc = new RpcClient("app", transport);
  rpc.start();
  transport.emit("ready");
  expect(transport.clearCalls).toBe(1);

  rpc.setActivity(null);
  expect(transport.clearCalls).toBe(1);

  transport.emit("disconnected");
  transport.emit("ready");
  await Promise.resolve();
  expect(transport.clearCalls).toBe(2);

  await rpc.stop();
  expect(transport.clearCalls).toBe(3);
  expect(transport.destroyCalls).toBe(1);
});

test("the desired activity is restored after reconnecting", async () => {
  const transport = new FakeTransport();
  const rpc = new RpcClient("app", transport);
  const activity: Activity = { type: 0, details: "Working", state: "Running a command" };
  rpc.setActivity(activity, 4321);

  transport.emit("ready");
  expect(transport.setCalls).toEqual([{ activity, pid: 4321 }]);

  transport.emit("disconnected");
  transport.emit("ready");
  await Promise.resolve();
  expect(transport.setCalls).toEqual([
    { activity, pid: 4321 },
    { activity, pid: 4321 },
  ]);
  await rpc.stop();
  expect(transport.clearPids.at(-1)).toBe(4321);
});
