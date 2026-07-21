import { Client } from "@xhayper/discord-rpc";
import type { Activity } from "./presence-builder.ts";
import { activityEquals } from "./presence-builder.ts";
import { createLogger } from "../util/logger.ts";

const log = createLogger("rpc");
const MIN_INTERVAL_MS = 2_000;
const REFRESH_INTERVAL_MS = 60_000;
const LOGIN_TIMEOUT_MS = 15_000;
const BACKOFFS_MS = [10_000, 30_000, 60_000];

export interface RpcClientTransport {
  readonly user:
    | {
        setActivity(activity: Activity, pid?: number): Promise<unknown>;
      }
    | undefined;
  on(event: "ready" | "disconnected", listener: () => void): unknown;
  login(): Promise<unknown>;
  destroy(): Promise<unknown>;
  request(command: "SET_ACTIVITY", args: { pid: number }): Promise<unknown>;
}

export type RpcClientTransportFactory = () => RpcClientTransport;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`login timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class RpcClient {
  private readonly factory: RpcClientTransportFactory;
  private readonly injected?: RpcClientTransport;
  private client?: RpcClientTransport;
  private ready = false;
  private stopped = false;
  private connecting = false;
  private desired: Activity | null = null;
  private desiredPid = process.pid;
  private lastSent: Activity | null | undefined;
  private lastSentPid?: number;
  private lastSendAt = 0;
  private sending = false;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private connectionGeneration = 0;

  constructor(applicationId: string, transport?: RpcClientTransport | RpcClientTransportFactory) {
    if (typeof transport === "function") {
      this.factory = transport;
    } else if (transport) {
      this.injected = transport;
      this.factory = () => transport;
    } else {
      this.factory = () => new Client({ clientId: applicationId }) as unknown as RpcClientTransport;
    }
    if (this.injected) this.acquireClient();
  }

  start(): void {
    this.stopped = false;
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    }
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.flushTimer = undefined;
    this.reconnectTimer = undefined;
    this.refreshTimer = undefined;
    const client = this.client;
    if (!client) return;
    if (this.ready) {
      await client.request("SET_ACTIVITY", { pid: this.desiredPid }).catch(() => undefined);
    }
    this.ready = false;
    await client.destroy().catch(() => undefined);
  }

  private acquireClient(): RpcClientTransport {
    const previous = this.client;
    const next = this.factory();
    if (previous === next) return next;
    if (previous && !this.injected) void previous.destroy().catch(() => undefined);
    this.client = next;
    next.on("ready", () => {
      if (this.client !== next) return;
      this.connectionGeneration++;
      this.ready = true;
      this.lastSent = undefined;
      this.lastSentPid = undefined;
      this.lastSendAt = 0;
      this.reconnectAttempt = 0;
      log.info("connected to Discord");
      this.flush();
    });
    next.on("disconnected", () => {
      if (this.client !== next) return;
      this.connectionGeneration++;
      this.ready = false;
      log.warn("disconnected from Discord");
      this.scheduleReconnect();
    });
    return next;
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.ready) return;
    this.connecting = true;
    try {
      const client = this.acquireClient();
      await withTimeout(Promise.resolve(client.login()), LOGIN_TIMEOUT_MS);
    } catch (err) {
      this.ready = false;
      const message = (err as Error).message;
      log.warn(`connect failed (${message}); Discord may be closed`);
      if (!this.injected && this.client) {
        const stale = this.client;
        this.client = undefined;
        void stale.destroy().catch(() => undefined);
      }
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = BACKOFFS_MS[Math.min(this.reconnectAttempt, BACKOFFS_MS.length - 1)]!;
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  setActivity(activity: Activity | null, pid?: number): void {
    this.desired = activity;
    if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
      this.desiredPid = pid;
    } else if (activity !== null) {
      this.desiredPid = process.pid;
    }
    this.scheduleFlush();
  }

  private refresh(): void {
    if (this.stopped || !this.ready || this.desired === null) return;
    if (Date.now() - this.lastSendAt < REFRESH_INTERVAL_MS) return;
    this.lastSent = undefined;
    this.flush();
  }

  private scheduleFlush(): void {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - this.lastSendAt));
    if (wait === 0) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, wait);
    }
  }

  private flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.ready || this.sending) return;
    const user = this.client?.user;
    if (!user) return;

    const desired = this.desired;
    const pid = this.desiredPid;

    if (desired === null) {
      if (this.lastSent === null && this.lastSentPid === pid) return;
      void this.send(desired, pid);
      return;
    }

    if (this.lastSentPid === pid && this.lastSent !== null && activityEquals(desired, this.lastSent)) return;
    void this.send(desired, pid);
  }

  private async send(activity: Activity | null, pid: number): Promise<void> {
    const client = this.client;
    const user = client?.user;
    if (!client || !user || !this.ready || this.stopped) return;
    this.sending = true;
    const generation = this.connectionGeneration;
    this.lastSendAt = Date.now();
    try {
      if (activity === null) {
        await client.request("SET_ACTIVITY", { pid });
      } else {
        await user.setActivity(activity, pid);
      }
      if (generation === this.connectionGeneration) {
        this.lastSent = activity;
        this.lastSentPid = pid;
      }
    } catch (err) {
      log.warn(`${activity === null ? "clearActivity" : "setActivity"} failed: ${(err as Error).message}`);
    } finally {
      this.sending = false;
      if (!this.stopped) this.scheduleFlush();
    }
  }
}
