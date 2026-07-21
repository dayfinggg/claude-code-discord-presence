import type { EffortLevel, PresenceState } from "../types.ts";

export interface Activity {
  type: number;
  name?: string;
  statusDisplayType?: 0 | 1 | 2;
  details: string;
  state: string;
  largeImageKey?: string;
  largeImageUrl?: string;
  largeImageText?: string;
  smallImageKey?: string;
  smallImageUrl?: string;
  smallImageText?: string;
  startTimestamp?: number;
  endTimestamp?: number;
}

export interface ActivityAssets {
  appName: string;
  largeImageKey?: string;
  largeImageUrl?: string;
  smallImageKey?: string;
  smallImageUrl?: string;
}

export interface DetailsOptions {
  showResetCountdowns?: boolean;
  now?: number;
}

const MIN = 2;
const MAX = 128;
const SEP = " • ";

const EFFORT_LABELS: Record<EffortLevel, string> = {
  minimal: "Minimal",
  low: "Light",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

export function effortLabel(level: EffortLevel): string {
  return EFFORT_LABELS[level];
}

export function modelDisplayName(id?: string, fallback?: string): string {
  const fallbackName = fallback?.trim();
  if (fallbackName && !/[-_[\]]/.test(fallbackName)) return fallbackName;
  const raw = fallbackName || id?.trim();
  if (raw) {
    const normalized = raw
      .replace(/^claude[-_\s]+/i, "")
      .replace(/\s*\[[^\]]*\]\s*$/g, "")
      .replace(/[_\s]+/g, "-")
      .replace(/-(?:latest|\d+[km]|\d{8})$/i, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const tokens = normalized.split("-").filter(Boolean);
    const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    if (/^\d/.test(tokens[0] ?? "")) {
      const version: string[] = [];
      while (tokens.length > 0 && /^\d+(?:\.\d+)?$/.test(tokens[0]!)) version.push(tokens.shift()!);
      const family = tokens.shift();
      if (family) return `${title(family)} ${version.join(".")}`.trim();
    } else {
      const family: string[] = [];
      while (tokens.length > 0 && !/^\d+(?:\.\d+)?$/.test(tokens[0]!)) family.push(tokens.shift()!);
      const version: string[] = [];
      while (tokens.length > 0 && /^\d+(?:\.\d+)?$/.test(tokens[0]!)) version.push(tokens.shift()!);
      if (family.length > 0) {
        return `${family.map(title).join(" ")}${version.length > 0 ? ` ${version.join(".")}` : ""}`;
      }
    }
    if (normalized) return normalized;
  }
  return "Claude";
}

function pctLeft(usedPercentage: number): number {
  const left = Math.round(100 - usedPercentage);
  return Math.max(0, Math.min(100, left));
}

export function formatGoalDuration(elapsedSeconds?: number): string {
  const totalMinutes = Math.max(0, Math.floor((elapsedSeconds ?? 0) / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function goalChip(state: PresenceState): string | undefined {
  return state.goalActive ? `Goal active (${formatGoalDuration(state.goalElapsedSeconds)})` : undefined;
}

export function clamp(text: string): string {
  let out = text;
  if (byteLength(out) > MAX) out = fitBytes(out, MAX, true);
  if (out.length < MIN) out = (out + "  ").slice(0, MIN);
  return out;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function fitBytes(text: string, maxBytes: number, ellipsis: boolean): string {
  const suffix = ellipsis ? "…" : "";
  const suffixBytes = byteLength(suffix);
  if (maxBytes <= suffixBytes) return suffix.slice(0, maxBytes);
  let fitted = text;
  while (fitted !== "" && byteLength(fitted) + suffixBytes > maxBytes) fitted = fitted.slice(0, -1);
  return fitted.trimEnd() + suffix;
}

export function formatResetCountdown(resetsAt: number | undefined, now = Date.now()): string | undefined {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || resetsAt <= now) return undefined;
  const totalMinutes = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  return `${minutes}m`;
}

function limitText(
  label: string,
  usedPercentage: number,
  resetsAt: number | undefined,
  options: DetailsOptions,
): string {
  let text = `${label} ${pctLeft(usedPercentage)}% left`;
  if (!options.showResetCountdowns) return text;
  const countdown = formatResetCountdown(resetsAt, options.now);
  if (countdown) text += ` (resets in ${countdown})`;
  return text;
}

export function buildDetails(state: PresenceState, options: DetailsOptions = {}): string {
  const segments: string[] = [];
  if (state.planName.trim() !== "") segments.push(state.planName);
  if (state.resetCreditsAvailable !== undefined && state.resetCreditsAvailable > 0) {
    const noun = state.resetCreditsAvailable === 1 ? "reset" : "resets";
    segments.push(`${state.resetCreditsAvailable} ${noun} left`);
  }
  const five = state.limits?.fiveHour;
  const seven = state.limits?.sevenDay;
  const scoped = state.limits?.sevenDayScoped;
  if (five) {
    segments.push(limitText("5h", five.usedPercentage, five.resetsAt, options));
  }

  const scopedText = scoped
    ?.map((s) => `${s.label} ${pctLeft(s.usedPercentage)}% left`)
    .join(", ");
  if (seven) {
    let sevenText = limitText("7d", seven.usedPercentage, seven.resetsAt, options);
    if (scopedText) sevenText += ` (${scopedText})`;
    segments.push(sevenText);
  } else if (scopedText) {
    segments.push(`7d ${scopedText}`);
  }

  return clamp(segments.join(SEP));
}

function tailChips(state: PresenceState): string {
  const chips: string[] = [];
  const goal = goalChip(state);
  if (goal) chips.push(goal);
  if (state.planMode) chips.push("Plan mode");
  if (state.agentsRunning > 0) {
    const noun = state.agentsRunning === 1 ? "agent" : "agents";
    let chip = `${state.agentsRunning} ${noun} running`;
    if (state.agentsIdle > 0) chip += ` (${state.agentsIdle} idle)`;
    chips.push(chip);
  }
  if (state.realtime) chips.push("Realtime");
  if (state.remote) chips.push("Remote");
  return chips.join(SEP);
}

function requiredTailChips(state: PresenceState): string {
  const chips: string[] = [];
  const goal = goalChip(state);
  if (goal) chips.push(goal);
  return chips.join(SEP);
}

export function buildStateLine(state: PresenceState): string {
  const effort = state.effort ? ` (${effortLabel(state.effort)})` : "";
  const fast = state.fastMode ? " Fast" : "";
  const head = state.model ? `${state.model.displayName}${effort}${fast}` : state.fastMode ? "Fast" : "";
  const action = state.status === "thinking" && state.thinkingSeconds !== undefined
    ? `Thinking (${Math.max(0, Math.floor(state.thinkingSeconds))}s)`
    : state.action.trim();
  const tail = tailChips(state);

  const priority = [head, action, tail].filter((s) => s !== "");
  if (priority.length === 0) return clamp("Claude Code");

  let line = priority.join(SEP);
  if (byteLength(line) <= MAX) return clamp(line);

  const requiredTail = requiredTailChips(state);
  if (requiredTail !== "") {
    const fixedLength = byteLength([head, requiredTail].filter((s) => s !== "").join(SEP));
    const actionBudget = MAX - fixedLength - (action !== "" ? byteLength(SEP) : 0);
    const fittedAction =
      actionBudget <= 0
        ? ""
        : byteLength(action) > actionBudget
          ? fitBytes(action, actionBudget, true)
          : action;
    return clamp([head, fittedAction, requiredTail].filter((s) => s !== "").join(SEP));
  }

  const headOnly = head !== "" ? head : action;
  const withAction = [head, action].filter((s) => s !== "").join(SEP);
  if (byteLength(withAction) <= MAX) return clamp(withAction);
  return clamp(headOnly);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1).replace(/\.0$/, "")}T`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
}

export function formatCost(usd: number): string {
  if (usd >= 0.1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

export function formatMonthlyUsage(state: PresenceState): string | undefined {
  const monthly = state.monthlyUsage;
  if (!monthly || (monthly.totalTokens <= 0 && monthly.costUsd <= 0)) return undefined;
  if (!monthly.day || !monthly.week || !monthly.allTime) {
    return `Month\u00a0$${formatMonthlyCost(monthly.costUsd)}·${formatTokens(monthly.totalTokens)}\u00a0tok`;
  }
  const period = (label: string, usage: { costUsd: number; totalTokens: number }) =>
    `${label}\u00a0$${formatMonthlyCost(usage.costUsd)}·${formatTokens(usage.totalTokens)}\u00a0tok`;
  return clampBytes([
    period("Day", monthly.day),
    period("Week", monthly.week),
    period("Month", monthly),
    period("Total", monthly.allTime),
  ].join("\n"), MAX);
}

function formatMonthlyCost(costUsd: number): string {
  if (costUsd < 10) return costUsd.toFixed(2);
  if (costUsd < 100) return costUsd.toFixed(1).replace(/\.0$/, "");
  if (Math.round(costUsd) < 1_000) return String(Math.round(costUsd));
  return `${(costUsd / 1_000).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}K`;
}

function clampBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let out = text;
  while (out.length > 0 && encoder.encode(out).length > maxBytes) out = out.slice(0, -1);
  return out;
}

export function buildHoverText(state: PresenceState, appName: string): string {
  const usage = state.usage;
  if (!usage) return appName;
  const cost = state.costBreakdown;
  const seg = (label: string, tokens: number, price?: number): string =>
    price !== undefined ? `${label} ${formatTokens(tokens)} ${formatCost(price)}` : `${label} ${formatTokens(tokens)}`;

  const parts = [seg("In", usage.input, cost?.input), seg("Out", usage.output, cost?.output)];
  if (usage.cacheRead > 0) parts.push(seg("Cache R", usage.cacheRead, cost?.cacheRead));
  if (usage.cacheWrite > 0) parts.push(seg("Cache W", usage.cacheWrite, cost?.cacheWrite));
  if (cost) parts.push(`Total ${formatCost(cost.total)}`);

  const encoder = new TextEncoder();
  while (parts.length > 1 && encoder.encode(parts.join(SEP)).length > 128) parts.pop();
  return clampBytes(parts.join(SEP), 128);
}

export function buildActivity(state: PresenceState, assets: ActivityAssets): Activity {
  const activity: Activity = {
    type: 0,
    name: assets.appName,
    details: buildDetails(state),
    state: buildStateLine(state),
  };
  const hover = buildHoverText(state, assets.appName);
  if (assets.largeImageKey) {
    activity.largeImageKey = assets.largeImageKey;
    activity.largeImageText = hover;
  } else if (assets.largeImageUrl) {
    activity.largeImageUrl = assets.largeImageUrl;
    activity.largeImageText = hover;
  }
  const monthlyHover = formatMonthlyUsage(state);
  if (monthlyHover && assets.smallImageKey) {
    activity.smallImageKey = assets.smallImageKey;
    activity.smallImageText = monthlyHover;
  } else if (monthlyHover && assets.smallImageUrl) {
    activity.smallImageUrl = assets.smallImageUrl;
    activity.smallImageText = monthlyHover;
  }
  if (state.startTimestamp) activity.startTimestamp = state.startTimestamp;
  return activity;
}

export function activityEquals(a: Activity | undefined, b: Activity | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.type === b.type &&
    a.name === b.name &&
    a.statusDisplayType === b.statusDisplayType &&
    a.details === b.details &&
    a.state === b.state &&
    a.largeImageKey === b.largeImageKey &&
    a.largeImageUrl === b.largeImageUrl &&
    a.largeImageText === b.largeImageText &&
    a.smallImageKey === b.smallImageKey &&
    a.smallImageUrl === b.smallImageUrl &&
    a.smallImageText === b.smallImageText &&
    a.startTimestamp === b.startTimestamp &&
    a.endTimestamp === b.endTimestamp
  );
}
