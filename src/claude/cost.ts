import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { CostBreakdown, UsageTotals } from "../types.ts";
import pricingConfig from "../../pricing.json" with { type: "json" };
import { claudeConfigDir } from "./paths.ts";

interface Pricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheWriteOneHour?: number;
  cacheRead: number;
  fastMultiplier?: number;
}

const DEFAULT_PRICING = pricingConfig.claude.models as Record<string, Pricing>;

const PRICING_PATH = join(claudeConfigDir(), "discord-rpc-pricing.json");
let pricing: Record<string, Pricing> = { ...DEFAULT_PRICING };

export function loadPricingOverrides(): boolean {
  if (!existsSync(PRICING_PATH)) return false;
  try {
    const overrides = JSON.parse(readFileSync(PRICING_PATH, "utf8")) as Record<string, Partial<Pricing>>;
    pricing = { ...DEFAULT_PRICING };
    for (const [id, p] of Object.entries(overrides)) {
      const base = pricing[normalizeModelId(id)] ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      pricing[normalizeModelId(id)] = { ...base, ...p };
    }
    return true;
  } catch {
    return false;
  }
}

export function normalizeModelId(id: string): string {
  return id.replace(/-fast$/, "").replace(/-\d{8}$/, "");
}

export function costBreakdown(model: string, usage: UsageTotals): CostBreakdown {
  const price = pricing[normalizeModelId(model)];
  if (!price) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const multiplier = model.endsWith("-fast") ? (price.fastMultiplier ?? 1) : 1;
  const oneHour = Math.min(usage.cacheWrite, usage.cacheWriteOneHour ?? 0);
  const input = (usage.input * price.input * multiplier) / 1_000_000;
  const output = (usage.output * price.output * multiplier) / 1_000_000;
  const cacheRead = (usage.cacheRead * price.cacheRead * multiplier) / 1_000_000;
  const cacheWrite = (
    (usage.cacheWrite - oneHour) * price.cacheWrite +
    oneHour * (price.cacheWriteOneHour ?? price.cacheWrite * 2)
  ) * multiplier / 1_000_000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

export function costUsd(model: string, usage: UsageTotals): number {
  return costBreakdown(model, usage).total;
}

export function costForUsageByModel(usageByModel: Record<string, UsageTotals>): CostBreakdown {
  const total: CostBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  for (const [model, usage] of Object.entries(usageByModel)) {
    const breakdown = costBreakdown(model, usage);
    total.input += breakdown.input;
    total.output += breakdown.output;
    total.cacheRead += breakdown.cacheRead;
    total.cacheWrite += breakdown.cacheWrite;
    total.total += breakdown.total;
  }
  return total;
}
