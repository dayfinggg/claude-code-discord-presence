import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "../util/logger.ts";

const log = createLogger("remote-tunnel");
const BACKOFFS_MS = [5_000, 15_000, 60_000];
const SSH_ALIAS = /^[a-z0-9](?:[a-z0-9._-]{0,252}[a-z0-9])?$/i;

export function isSafeSshAlias(value: string): boolean {
  return SSH_ALIAS.test(value);
}

export function remoteForwardArguments(host: string, localPort: number, remotePort: number): string[] {
  if (!isSafeSshAlias(host)) throw new Error(`Unsafe SSH alias: ${JSON.stringify(host)}`);
  return [
    "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-R", `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
    host,
  ];
}

export class RemoteTunnelManager {
  private stopped = false;
  private readonly children = new Map<string, ChildProcess>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly hosts: readonly string[],
    private readonly localPort: number,
    private readonly remotePort: number,
  ) {}

  start(): void {
    this.stopped = false;
    for (const host of this.hosts) this.connect(host, 0);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const child of this.children.values()) child.kill();
    this.children.clear();
  }

  private connect(host: string, attempt: number): void {
    if (this.stopped) return;
    const child = spawn("ssh", remoteForwardArguments(host, this.localPort, this.remotePort), {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.children.set(host, child);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_048);
    });
    let settled = false;
    const reconnect = (reason: string): void => {
      if (settled) return;
      settled = true;
      this.children.delete(host);
      if (this.stopped) return;
      if (attempt === 0) log.warn(`SSH tunnel to ${host} stopped (${reason}); reconnecting`);
      const delay = BACKOFFS_MS[Math.min(attempt, BACKOFFS_MS.length - 1)]!;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.connect(host, attempt + 1);
      }, delay);
      this.timers.add(timer);
    };
    child.once("error", (err) => reconnect(err.message));
    child.once("exit", (code) => reconnect(stderr.trim() || `exit ${code ?? "unknown"}`));
  }
}
