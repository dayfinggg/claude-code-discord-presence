import type { Limits, LimitWindow, ScopedLimit, StatuslinePayload, UsageApiResponse } from "../types.ts";

function epochSecondsToMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

function isoToMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function percentage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

export function limitsFromStatusline(
  rateLimits: StatuslinePayload["rate_limits"],
  at: number,
): Limits | undefined {
  if (!rateLimits) return undefined;
  const limits: Limits = { updatedAt: at };
  const five = rateLimits.five_hour;
  const seven = rateLimits.seven_day;
  const fiveUsed = percentage(five?.used_percentage);
  const sevenUsed = percentage(seven?.used_percentage);
  if (fiveUsed !== undefined) {
    limits.fiveHour = { usedPercentage: fiveUsed, resetsAt: epochSecondsToMs(five?.resets_at) };
  }
  if (sevenUsed !== undefined) {
    limits.sevenDay = { usedPercentage: sevenUsed, resetsAt: epochSecondsToMs(seven?.resets_at) };
  }
  if (!limits.fiveHour && !limits.sevenDay) return undefined;
  return limits;
}

export function limitsFromUsage(usage: UsageApiResponse, at: number): Limits | undefined {
  const limits: Limits = { updatedAt: at };
  const fiveUsed = percentage(usage.five_hour?.utilization);
  const sevenUsed = percentage(usage.seven_day?.utilization);
  if (fiveUsed !== undefined) {
    limits.fiveHour = { usedPercentage: fiveUsed, resetsAt: isoToMs(usage.five_hour?.resets_at) };
  }
  if (sevenUsed !== undefined) {
    limits.sevenDay = { usedPercentage: sevenUsed, resetsAt: isoToMs(usage.seven_day?.resets_at) };
  }

  const scoped: ScopedLimit[] = [];
  for (const entry of usage.limits ?? []) {
    if (entry.kind !== "weekly_scoped") continue;
    const label = entry.scope?.model?.display_name;
    const used = percentage(entry.percent);
    if (typeof label === "string" && label !== "" && used !== undefined) {
      scoped.push({ label, usedPercentage: used });
    }
  }
  if (scoped.length > 0) limits.sevenDayScoped = scoped;

  if (!limits.fiveHour && !limits.sevenDay && !limits.sevenDayScoped) return undefined;
  return limits;
}

function pickWindow(
  a: LimitWindow | undefined,
  aAt: number,
  b: LimitWindow | undefined,
  bAt: number,
): LimitWindow | undefined {
  if (a && b) return aAt >= bAt ? a : b;
  return a ?? b;
}

export function mergeLimits(a?: Limits, b?: Limits, preferB = false): Limits | undefined {
  if (!a) return b;
  if (!b) return a;
  const fiveHour = preferB
    ? b.fiveHour ?? a.fiveHour
    : pickWindow(a.fiveHour, a.updatedAt, b.fiveHour, b.updatedAt);
  const sevenDay = preferB
    ? b.sevenDay ?? a.sevenDay
    : pickWindow(a.sevenDay, a.updatedAt, b.sevenDay, b.updatedAt);
  const fresher = a.updatedAt >= b.updatedAt ? a : b;
  const older = a.updatedAt >= b.updatedAt ? b : a;
  const scoped = preferB
    ? b.sevenDayScoped ?? a.sevenDayScoped
    : fresher.sevenDayScoped ?? older.sevenDayScoped;
  const merged: Limits = { updatedAt: Math.max(a.updatedAt, b.updatedAt) };
  if (fiveHour) merged.fiveHour = fiveHour;
  if (sevenDay) merged.sevenDay = sevenDay;
  if (scoped) merged.sevenDayScoped = scoped;
  return merged;
}
