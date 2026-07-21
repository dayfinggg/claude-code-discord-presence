import { existsSync, mkdirSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { startServer } from "./server/http-server.ts";
import { SessionStore } from "./claude/session-store.ts";
import { DesktopFocusWatcher } from "./claude/desktop-focus.ts";
import { ClaudeDefaultSelectionWatcher } from "./claude/default-selection.ts";
import { ClaudeAppLiveness } from "./claude/app-liveness.ts";
import { UsagePoller } from "./claude/usage-poller.ts";
import { ClaudeMonthlyUsageWatcher } from "./claude/monthly-usage.ts";
import { getDefaultEffort, getPlanName } from "./claude/plan-info.ts";
import { loadPricingOverrides } from "./claude/cost.ts";
import { buildActivity, type Activity } from "./discord/presence-builder.ts";
import { RpcClient } from "./discord/rpc-client.ts";
import {
  CLAUDE_WINDOWS_PROCESS_RULES,
  ProcessLiveness,
} from "./util/process-liveness.ts";
import { ProcessRuleTracker, WindowsProcessScanWatcher } from "./util/process-scan-watcher.ts";
import { configureLogger, createLogger } from "./util/logger.ts";
import { activityAssetsForTheme, type ResolvedTheme } from "./appearance/theme-assets.ts";
import { AppearanceThemeWatcher } from "./appearance/theme-watcher.ts";
import { RemoteTunnelManager } from "./remote/tunnel-manager.ts";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
configureLogger(config.logFile);
const log = createLogger("main");

process.on("uncaughtException", (err) => {
  log.error(`uncaught exception: ${err.stack ?? err.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

if (loadPricingOverrides()) log.info("loaded pricing overrides");

const assets = {
  appName: config.appName,
  largeImageKey: config.largeImageKey,
  largeImageKeyLight: config.largeImageKeyLight,
  largeImageKeyDark: config.largeImageKeyDark,
  largeImageUrl: config.largeImageUrl,
  smallImageKey: config.smallImageKey,
  smallImageKeyLight: config.smallImageKeyLight,
  smallImageKeyDark: config.smallImageKeyDark,
  smallImageUrl: config.smallImageUrl,
};

const rpc = new RpcClient(config.applicationId);
let theme: ResolvedTheme = "light";
let trackedPid: number | undefined;
let desired: Activity | null = null;

function coalesce(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      fn();
    });
  };
}

function updateActivity(): void {
  const snapshot = store.snapshot();
  desired = snapshot ? buildActivity(snapshot, activityAssetsForTheme(assets, theme)) : null;
  rpc.setActivity(desired, trackedPid);
}

const store = new SessionStore(coalesce(updateActivity));

interface LivenessState {
  alive: boolean;
  startedAt?: number;
  pid?: number;
}
const livenessSources = new Map<string, LivenessState>();
function updateLivenessSource(source: string, alive: boolean, startedAt?: number, pid?: number): void {
  livenessSources.set(source, { alive, startedAt, pid });
  const live = [...livenessSources.values()].filter((state) => state.alive);
  const earliest = live.reduce<LivenessState | undefined>((current, state) => {
    if (!current) return state;
    if (state.startedAt === undefined) return current;
    if (current.startedAt === undefined || state.startedAt < current.startedAt) return state;
    return current;
  }, undefined);
  const aliveNow = live.length > 0;
  trackedPid = aliveNow ? earliest?.pid ?? live.find((state) => state.pid)?.pid : undefined;
  store.setAppLiveness(aliveNow, earliest?.startedAt);
  if (desired) rpc.setActivity(desired, trackedPid);
}

const processScan = process.platform === "win32"
  ? (() => {
      const tracker = new ProcessRuleTracker(
        "claude",
        CLAUDE_WINDOWS_PROCESS_RULES,
        (alive, startedAt, pid) => updateLivenessSource("process", alive, startedAt, pid),
      );
      return new WindowsProcessScanWatcher("^claude$", (processes) => tracker.update(processes));
    })()
  : undefined;
const sessionLiveness = process.platform === "win32"
  ? undefined
  : new ClaudeAppLiveness((alive, startedAt, pid) =>
      updateLivenessSource("session", alive, startedAt, pid));
const processLiveness = process.platform === "win32"
  ? undefined
  : new ProcessLiveness(/^claude$/i, (alive, startedAt, pid) =>
      updateLivenessSource("process", alive, startedAt, pid));

const desktopFocus = config.desktopSessionsDir
  ? new DesktopFocusWatcher(config.desktopSessionsDir, (focus) =>
      store.setDesktopFocus(focus.cliSessionId, focus))
  : undefined;
const defaultSelection = new ClaudeDefaultSelectionWatcher({}, (selection) => {
  store.setDefaultModel(selection.model);
  store.setDefaultEffort(selection.effort);
});
const poller = new UsagePoller(config.usagePollIntervalMs, (limits) => store.setUsageLimits(limits));
const monthlyUsage = new ClaudeMonthlyUsageWatcher((usage) => store.setMonthlyUsage(false, usage));
const themeWatcher = new AppearanceThemeWatcher({}, (themes) => {
  theme = themes.claude;
  updateActivity();
});
const server = startServer(config.port, {
  onHook: (payload) => store.handleHook(payload),
  onStatusline: (payload) => store.handleStatusline(payload),
});
const remoteTunnels = new RemoteTunnelManager(config.remoteHosts, config.port, config.remotePort);

async function refreshPlan(): Promise<void> {
  try {
    store.setPlanName(await getPlanName());
    store.setDefaultEffort(await getDefaultEffort());
  } catch (err) {
    log.warn(`plan refresh failed: ${(err as Error).message}`);
  }
}

rpc.start();
themeWatcher.start();
poller.start();
if (desktopFocus) void desktopFocus.start();
defaultSelection.start();
processScan?.start();
sessionLiveness?.start();
processLiveness?.start();
monthlyUsage.start();
remoteTunnels.start();
void refreshPlan();
const planTimer = setInterval(() => void refreshPlan(), 30 * 60 * 1000);
const stopFile = process.env.PRESENCE_STOP_FILE?.trim();
let stopFileTimer: ReturnType<typeof setInterval> | undefined;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down (${signal})`);
  clearInterval(planTimer);
  if (stopFileTimer) clearInterval(stopFileTimer);
  themeWatcher.stop();
  poller.stop();
  desktopFocus?.stop();
  defaultSelection.stop();
  processScan?.stop();
  sessionLiveness?.stop();
  processLiveness?.stop();
  monthlyUsage.stop();
  remoteTunnels.stop();
  store.dispose();
  await rpc.stop();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
if (stopFile) {
  stopFileTimer = setInterval(() => {
    if (existsSync(stopFile)) void shutdown("autostart removal");
  }, 500);
}
log.info("Claude Code Discord Presence started");
