import type {
  EffortLevel,
  HookPayload,
  Limits,
  ModelInfo,
  MonthlyUsage,
  PresenceState,
  SessionStatus,
  StatuslinePayload,
} from "../types.ts";
import type { UsageTotals } from "../types.ts";
import { limitsFromStatusline, mergeLimits } from "./limits.ts";
import { toolLabel } from "./tool-labels.ts";
import { readModelFromTranscript, readSessionStats, findTranscriptPath } from "./transcript.ts";
import { costBreakdown, costForUsageByModel } from "./cost.ts";
import { modelDisplayName } from "../discord/presence-builder.ts";

const IDLE_MS = 10 * 60 * 1000;
const APP_CLOSE_GRACE_MS = 45_000;
const EFFORT_LEVELS: ReadonlySet<string> = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

interface Session {
  sessionId: string;
  startTimestamp: number;
  lastActivity: number;
  lastInteractionAt: number;
  model?: ModelInfo;
  modelUpdatedAt: number;
  runtimeModel?: ModelInfo;
  runtimeModelAt: number;
  runtimeModelEvent?: string;
  runtimeModelFloorAt: number;
  desktopModelKnown: boolean;
  desktopEffortKnown: boolean;
  hasHookActivity: boolean;
  effort?: EffortLevel;
  fastMode?: boolean;
  status: SessionStatus;
  thinkingStartedAt?: number;
  action: string;
  permissionMode?: string;
  remote?: boolean;
  agents: Set<string>;
  idleAgents: number;
  statuslineLimits?: Limits;
  transcriptPath?: string;
  lastTranscriptLocateAt: number;
  lastModelReadAt: number;
  usage?: UsageTotals;
  usageByModel?: Record<string, UsageTotals>;
  lastStatsReadAt: number;
}

export interface DesktopFocusInfo {
  focusedAt: number;
  lastActivityAt?: number;
  updatedAt?: number;
  model?: string;
  effort?: string;
  failed?: boolean;
}

function effortOf(raw: unknown): EffortLevel | undefined {
  return typeof raw === "string" && EFFORT_LEVELS.has(raw) ? (raw as EffortLevel) : undefined;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRemoteTranscript(path: string, explicit?: boolean): boolean {
  return explicit === true || (process.platform === "win32" && path.startsWith("/"));
}

function modelOf(raw: unknown, displayName?: string): ModelInfo | undefined {
  if (typeof raw === "string" && raw.trim() !== "") {
    return { id: raw, displayName: modelDisplayName(raw, displayName) };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as { id?: unknown; display_name?: unknown };
    const id = typeof obj.id === "string" ? obj.id : "";
    const dn = typeof obj.display_name === "string" ? obj.display_name : displayName;
    if (id || dn) return { id, displayName: modelDisplayName(id || undefined, dn) };
  }
  if (displayName) return { id: "", displayName };
  return undefined;
}

function actionForStatus(status: SessionStatus, working: string, agentsRunning: boolean): string {
  switch (status) {
    case "new":
      return "Waiting for a prompt";
    case "thinking":
      return "Thinking";
    case "idle":
      return agentsRunning ? "Waiting for agents" : "Idle";
    case "waiting":
      return "Waiting for input";
    case "working":
      return working;
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private activeId?: string;
  private planName = "Claude";
  private usageLimits?: Limits;
  private localMonthlyUsage?: MonthlyUsage;
  private remoteMonthlyUsage?: MonthlyUsage;
  private defaultEffort?: EffortLevel;
  private defaultModel?: ModelInfo;
  private activeSince?: number;
  private appAlive = false;
  private appLivenessKnown = false;
  private appStartedAt?: number;
  private cleared = false;
  private pendingFocus?: { sessionId: string; timer: ReturnType<typeof setTimeout> };
  private readonly focusDebounceMs: number;
  private readonly appCloseGraceMs: number;
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private readonly modelTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly onChange: () => void,
    options: { focusDebounceMs?: number; appCloseGraceMs?: number; modelPollIntervalMs?: number } = {},
  ) {
    this.focusDebounceMs = options.focusDebounceMs ?? 600;
    this.appCloseGraceMs = options.appCloseGraceMs ?? APP_CLOSE_GRACE_MS;
    this.idleTimer = setInterval(() => this.checkIdle(), 5_000);
    this.modelTimer = setInterval(() => void this.pollActiveModel(), options.modelPollIntervalMs ?? 2_000);
  }

  dispose(): void {
    clearInterval(this.idleTimer);
    clearInterval(this.modelTimer);
    this.clearPendingFocus();
  }

  setPlanName(name: string): void {
    if (name === this.planName) return;
    this.planName = name;
    this.onChange();
  }

  setUsageLimits(limits: Limits): void {
    this.usageLimits = limits;
    this.onChange();
  }

  setMonthlyUsage(remote: boolean, usage: MonthlyUsage): void {
    const current = remote ? this.remoteMonthlyUsage : this.localMonthlyUsage;
    if (
      current?.totalTokens === usage.totalTokens &&
      Math.abs((current?.costUsd ?? 0) - usage.costUsd) < 1e-9
    ) {
      return;
    }
    if (remote) this.remoteMonthlyUsage = usage;
    else this.localMonthlyUsage = usage;
    this.onChange();
  }

  setDefaultEffort(effort: EffortLevel | undefined): void {
    if (effort === this.defaultEffort) return;
    this.defaultEffort = effort;
    this.onChange();
  }

  setDefaultModel(model: string | undefined): void {
    const parsed = modelOf(model);
    if (parsed?.id === this.defaultModel?.id && parsed?.displayName === this.defaultModel?.displayName) return;
    this.defaultModel = parsed;
    this.onChange();
  }

  setAppLiveness(alive: boolean, startedAt?: number): void {
    const firstReport = !this.appLivenessKnown;
    this.appLivenessKnown = true;
    if (!firstReport && alive === this.appAlive && startedAt === this.appStartedAt) return;
    this.appAlive = alive;
    this.appStartedAt = alive ? startedAt : undefined;
    this.cleared = false;
    this.onChange();
  }

  private hidden(session: Session, now: number): boolean {
    if (this.appAlive) return false;
    const age = now - session.lastActivity;
    if (session.remote) return age > IDLE_MS;
    return this.appLivenessKnown || age > this.appCloseGraceMs;
  }

  private ensure(sessionId: string): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const now = Date.now();
      session = {
        sessionId,
        startTimestamp: now,
        lastActivity: now,
        lastInteractionAt: 0,
        modelUpdatedAt: 0,
        runtimeModelAt: 0,
        runtimeModelFloorAt: 0,
        desktopModelKnown: false,
        desktopEffortKnown: false,
        hasHookActivity: false,
        status: "idle",
        action: "Idle",
        agents: new Set(),
        idleAgents: 0,
        lastTranscriptLocateAt: 0,
        lastModelReadAt: 0,
        lastStatsReadAt: 0,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private touch(session: Session): void {
    session.lastActivity = Date.now();
    this.cleared = false;
    if (!this.activeId || !this.sessions.has(this.activeId)) this.activeId = session.sessionId;
  }

  private focus(session: Session): void {
    session.lastInteractionAt = Date.now();
    this.activeId = session.sessionId;
    this.cleared = false;
  }

  private scheduleFocus(session: Session): void {
    this.clearPendingFocus();
    if (this.focusDebounceMs <= 0) {
      this.focus(session);
      return;
    }
    const id = session.sessionId;
    this.pendingFocus = {
      sessionId: id,
      timer: setTimeout(() => {
        this.pendingFocus = undefined;
        const target = this.sessions.get(id);
        if (target) {
          this.focus(target);
          this.onChange();
        }
      }, this.focusDebounceMs),
    };
  }

  private clearPendingFocus(sessionId?: string): void {
    if (!this.pendingFocus) return;
    if (sessionId !== undefined && this.pendingFocus.sessionId !== sessionId) return;
    clearTimeout(this.pendingFocus.timer);
    this.pendingFocus = undefined;
  }

  private applySelectedModel(session: Session, model: ModelInfo | undefined, updatedAt = Date.now()): void {
    if (!model) return;
    const changed = session.model?.id !== model.id || session.model?.displayName !== model.displayName;
    const hadSelectedModel = session.model !== undefined;
    session.model = model;
    if (changed) {
      session.modelUpdatedAt = Math.max(session.modelUpdatedAt, updatedAt);
      if (hadSelectedModel) {
        session.runtimeModel = undefined;
        session.runtimeModelAt = 0;
        session.runtimeModelFloorAt = Math.max(session.runtimeModelFloorAt, updatedAt);
      }
    }
  }

  private applyRuntimeModel(session: Session, model: ModelInfo | undefined, updatedAt: number, event?: string): void {
    if (!model || updatedAt < session.runtimeModelFloorAt || (event && event === session.runtimeModelEvent)) return;
    session.runtimeModel = model;
    session.runtimeModelAt = updatedAt;
    session.runtimeModelEvent = event;
  }

  private effectiveModel(session: Session): ModelInfo | undefined {
    return session.runtimeModel ?? session.model;
  }

  private beginTurn(session: Session): void {
    const now = Date.now();
    session.runtimeModel = undefined;
    session.runtimeModelAt = 0;
    session.runtimeModelFloorAt = Math.max(session.runtimeModelFloorAt, now);
  }

  handleHook(payload: HookPayload): void {
    const sessionId = payload.session_id;
    if (!sessionId) return;
    const event = payload.hook_event_name ?? "";
    const agentId = typeof payload.agent_id === "string" && payload.agent_id !== "" ? payload.agent_id : undefined;
    const fromAgent = agentId !== undefined;
    const session = this.ensure(sessionId);
    const firstHook = !session.hasHookActivity;
    session.hasHookActivity = true;
    this.touch(session);
    const wasThinking = session.status === "thinking";

    if (typeof payload.permission_mode === "string") session.permissionMode = payload.permission_mode;
    if (typeof payload.transcript_path === "string") {
      const remote = isRemoteTranscript(payload.transcript_path, payload.remote);
      session.remote = remote;
      if (!remote) session.transcriptPath = payload.transcript_path;
    }
    if (!fromAgent) {
      const effort = effortOf(payload.effort?.level);
      if (effort && (firstHook || !session.desktopEffortKnown)) session.effort = effort;
      const model = modelOf(payload.model);
      if (firstHook || !session.desktopModelKnown) this.applySelectedModel(session, model);
    } else if (!this.effectiveModel(session)) {
      this.applySelectedModel(session, modelOf(payload.model));
    }
    if (payload.usage) this.applyUsage(session, payload.usage, payload.usage_by_model);

    switch (event) {
      case "SessionStart":
        session.status = "new";
        session.action = "Waiting for a prompt";
        this.scheduleFocus(session);
        break;
      case "UserPromptSubmit":
        this.beginTurn(session);
        session.status = "thinking";
        session.action = "Thinking";
        this.clearPendingFocus();
        this.focus(session);
        break;
      case "PreToolUse":
        if (fromAgent) {
          session.agents.add(agentId!);
          break;
        }
        session.status = "working";
        session.action = toolLabel(payload.tool_name, payload.tool_input);
        break;
      case "PostToolUse":
        break;
      case "Stop":
        session.status = "idle";
        session.action = "Idle";
        break;
      case "SubagentStart":
        if (payload.agent_id) session.agents.add(payload.agent_id);
        break;
      case "SubagentStop":
        if (payload.agent_id) session.agents.delete(payload.agent_id);
        if (session.idleAgents > session.agents.size) session.idleAgents = session.agents.size;
        break;
      case "Notification":
        this.handleNotification(session, payload.notification_type);
        break;
      case "SessionEnd":
        this.clearPendingFocus(sessionId);
        this.sessions.delete(sessionId);
        if (this.activeId === sessionId) this.activeId = this.mostRecentId();
        break;
      default:
        break;
    }
    if (session.status === "thinking") {
      if (!wasThinking || session.thinkingStartedAt === undefined) session.thinkingStartedAt = Date.now();
    } else {
      delete session.thinkingStartedAt;
    }

    const turnBoundary = event === "SessionStart" || event === "UserPromptSubmit";
    if (!session.transcriptPath && turnBoundary) {
      void this.locateAndRefresh(session);
    } else if (session.transcriptPath) {
      if (!this.effectiveModel(session) || turnBoundary) void this.refreshModelFromTranscript(session);
      const statsEvent =
        event === "Stop" || event === "UserPromptSubmit" || event === "PostToolUse" || event === "SessionStart";
      if (statsEvent && !fromAgent) {
        void this.refreshStatsFromTranscript(session, event === "Stop" || event === "SessionStart");
      }
    }

    this.onChange();
  }

  private async refreshModelFromTranscript(session: Session): Promise<void> {
    const now = Date.now();
    if (now - session.lastModelReadAt < 1_000) return;
    session.lastModelReadAt = now;
    const found = await readModelFromTranscript(session.transcriptPath!);
    const current = this.effectiveModel(session);
    const id = found.main ?? (current ? undefined : found.any);
    if (id) {
      const before = this.effectiveModel(session);
      this.applyRuntimeModel(
        session,
        { id, displayName: modelDisplayName(id) },
        found.mainAt ?? now,
        found.mainEvent ?? `transcript:${id}`,
      );
      const after = this.effectiveModel(session);
      if (before?.id !== after?.id || before?.displayName !== after?.displayName) this.onChange();
    }
  }

  private async pollActiveModel(): Promise<void> {
    const session = this.active();
    if (!session) return;
    if (!session.transcriptPath) {
      await this.locateAndRefresh(session);
      return;
    }
    await this.refreshModelFromTranscript(session);
  }

  private async locateAndRefresh(session: Session): Promise<void> {
    const now = Date.now();
    if (now - session.lastTranscriptLocateAt < 2_000) return;
    session.lastTranscriptLocateAt = now;
    const path = await findTranscriptPath(session.sessionId);
    if (!path) return;
    session.transcriptPath = path;
    await this.refreshModelFromTranscript(session);
    await this.refreshStatsFromTranscript(session, true);
  }

  private async refreshStatsFromTranscript(session: Session, force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && session.usage && now - session.lastStatsReadAt < 5000) return;
    session.lastStatsReadAt = now;
    const stats = await readSessionStats(session.transcriptPath!);
    if (!stats) return;
    session.usage = stats.usage;
    session.usageByModel = stats.usageByModel;
    this.onChange();
  }

  private handleNotification(session: Session, type: string | undefined): void {
    switch (type) {
      case "permission_prompt":
      case "idle_prompt":
        session.status = "waiting";
        session.action = "Waiting for input";
        break;
      case "agent_needs_input":
        session.idleAgents = Math.min(session.agents.size, session.idleAgents + 1);
        break;
      case "agent_completed":
        if (session.idleAgents > 0) session.idleAgents -= 1;
        break;
      default:
        break;
    }
  }

  setDesktopFocus(sessionId: string, info: DesktopFocusInfo): void {
    if (!sessionId || !Number.isFinite(info.focusedAt) || info.focusedAt <= 0) return;
    if (info.failed) {
      this.clearPendingFocus(sessionId);
      this.sessions.delete(sessionId);
      if (this.activeId === sessionId) this.activeId = this.mostRecentId();
      this.cleared = false;
      this.onChange();
      return;
    }
    const existing = this.sessions.get(sessionId);
    const session = this.ensure(sessionId);
    if (!existing) {
      session.startTimestamp = Math.min(info.focusedAt, info.lastActivityAt ?? info.focusedAt);
      session.lastActivity = Math.max(info.focusedAt, info.lastActivityAt ?? 0);
    } else if (info.focusedAt > session.lastActivity) {
      session.lastActivity = info.focusedAt;
    }
    const desktopModel = modelOf(info.model);
    if (desktopModel) {
      session.desktopModelKnown = true;
      this.applySelectedModel(session, desktopModel, info.updatedAt ?? Date.now());
    }
    const effort = effortOf(info.effort);
    if (effort) {
      session.desktopEffortKnown = true;
      session.effort = effort;
    }

    const active = this.active();
    if (active && active.sessionId !== sessionId && active.lastInteractionAt > info.focusedAt) {
      this.onChange();
      return;
    }
    this.clearPendingFocus();
    if (info.focusedAt > session.lastInteractionAt) session.lastInteractionAt = info.focusedAt;
    this.activeId = sessionId;
    this.cleared = false;
    if (!session.transcriptPath) {
      void this.locateAndRefresh(session);
    } else if (!session.usage || !this.effectiveModel(session)) {
      void this.refreshStatsFromTranscript(session, true);
    }
    this.onChange();
  }

  private applyUsage(session: Session, usage: NonNullable<HookPayload["usage"]>, byModel?: HookPayload["usage_by_model"]): void {
    session.usage = {
      input: numeric(usage.input_tokens),
      output: numeric(usage.output_tokens),
      cacheRead: numeric(usage.cache_read_input_tokens),
      cacheWrite: numeric(usage.cache_creation_input_tokens),
    };
    if (byModel && typeof byModel === "object") {
      const map: Record<string, UsageTotals> = {};
      for (const [model, u] of Object.entries(byModel)) {
        if (!u || typeof u !== "object") continue;
        map[model] = {
          input: numeric(u.input_tokens),
          output: numeric(u.output_tokens),
          cacheRead: numeric(u.cache_read_input_tokens),
          cacheWrite: numeric(u.cache_creation_input_tokens),
        };
      }
      session.usageByModel = Object.keys(map).length > 0 ? map : undefined;
    } else {
      session.usageByModel = undefined;
    }
  }

  handleStatusline(payload: StatuslinePayload): void {
    const sessionId = payload.session_id;
    if (!sessionId) return;
    const session = this.ensure(sessionId);
    if (payload.remote === true) session.remote = true;
    session.hasHookActivity = true;
    this.touch(session);

    if (!session.desktopModelKnown) {
      this.applySelectedModel(session, modelOf(payload.model, payload.model?.display_name));
    }
    const effort = effortOf(payload.effort?.level);
    if (effort && !session.desktopEffortKnown) session.effort = effort;
    if (typeof payload.fast_mode === "boolean") session.fastMode = payload.fast_mode;
    if (typeof payload.permission_mode === "string") session.permissionMode = payload.permission_mode;

    const limits = limitsFromStatusline(payload.rate_limits, Date.now());
    if (limits) session.statuslineLimits = limits;

    const cw = payload.context_window?.current_usage;
    if (cw && !session.usage) {
      session.usage = {
        input: numeric(cw.input_tokens),
        output: numeric(cw.output_tokens),
        cacheRead: numeric(cw.cache_read_input_tokens),
        cacheWrite: numeric(cw.cache_creation_input_tokens),
      };
    }

    this.onChange();
  }

  private mostRecentId(now = Date.now()): string | undefined {
    let best: string | undefined;
    let bestAt = -1;
    for (const session of this.sessions.values()) {
      if (this.hidden(session, now)) continue;
      const at = Math.max(session.lastInteractionAt, session.lastActivity);
      if (at > bestAt) {
        bestAt = at;
        best = session.sessionId;
      }
    }
    return best;
  }

  private active(): Session | undefined {
    const now = Date.now();
    const current = this.activeId ? this.sessions.get(this.activeId) : undefined;
    if (current && now - current.lastActivity <= IDLE_MS && !this.hidden(current, now)) return current;
    const fallbackId = this.mostRecentId(now);
    const fallback = fallbackId ? this.sessions.get(fallbackId) : undefined;
    if (fallback && (!current || this.hidden(current, now) || fallback.lastActivity > current.lastActivity)) {
      this.activeId = fallbackId;
      return fallback;
    }
    return current;
  }

  private checkIdle(): void {
    const active = this.active();
    const now = Date.now();
    if (!active || now - active.lastActivity > IDLE_MS || this.hidden(active, now)) {
      if (!this.cleared) {
        this.cleared = true;
        this.onChange();
      } else if (active && (this.usageLimits || active.statuslineLimits)) {
        this.onChange();
      }
      return;
    }
    if (active.status === "thinking" || this.usageLimits || active.statuslineLimits) this.onChange();
  }

  snapshot(): PresenceState | undefined {
    const active = this.active();
    const now = Date.now();
    if (!active || this.hidden(active, now)) {
      this.activeSince = undefined;
      return undefined;
    }
    const stale = now - active.lastActivity > IDLE_MS;
    if (this.appAlive && this.appStartedAt !== undefined) {
      this.activeSince = Math.min(this.appStartedAt, now);
    } else if (this.activeSince === undefined) {
      this.activeSince = Math.min(active.startTimestamp, now);
    }

    const status: SessionStatus = stale ? "idle" : active.status;
    const agentsRunning = stale ? 0 : active.agents.size;
    const state: PresenceState = {
      planName: this.planName,
      action: actionForStatus(status, active.action, agentsRunning > 0),
      status,
      planMode: !stale && active.permissionMode === "plan",
      agentsRunning,
      agentsIdle: stale ? 0 : Math.min(active.idleAgents, active.agents.size),
      startTimestamp: this.activeSince,
    };
    if (!stale && status === "thinking" && active.thinkingStartedAt !== undefined) {
      state.thinkingSeconds = Math.max(0, Math.floor((now - active.thinkingStartedAt) / 1000));
    }
    const model = !active.hasHookActivity && this.defaultModel ? this.defaultModel : this.effectiveModel(active);
    if (model) state.model = model;
    const effort = !active.hasHookActivity && this.defaultEffort ? this.defaultEffort : active.effort ?? this.defaultEffort;
    if (effort) state.effort = effort;
    if (active.fastMode !== undefined) state.fastMode = active.fastMode;
    // The account usage endpoint is authoritative when available. Some Claude clients emit
    // placeholder zeroes in statusline input, which would otherwise display a false 100% left.
    const limits = mergeLimits(active.statuslineLimits, this.usageLimits, true);
    if (limits) state.limits = limits;
    if (active.usage) {
      state.usage = active.usage;
      const byModel = active.usageByModel;
      if (byModel && Object.keys(byModel).length > 0) {
        const breakdown = costForUsageByModel(byModel);
        state.costBreakdown = breakdown;
        state.costUsd = breakdown.total;
      } else if (model?.id) {
        const breakdown = costBreakdown(model.id, active.usage);
        state.costBreakdown = breakdown;
        state.costUsd = breakdown.total;
      }
    }
    const monthlyUsage = active.remote ? this.remoteMonthlyUsage : this.localMonthlyUsage;
    if (monthlyUsage) state.monthlyUsage = monthlyUsage;
    return state;
  }
}
