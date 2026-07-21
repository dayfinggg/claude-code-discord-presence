export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type SessionStatus = "new" | "thinking" | "working" | "idle" | "waiting";

export interface ModelInfo {
  id: string;
  displayName: string;
}

export interface LimitWindow {
  usedPercentage: number;
  resetsAt?: number;
}

export interface ScopedLimit {
  label: string;
  usedPercentage: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWriteOneHour?: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface MonthlyUsage {
  totalTokens: number;
  costUsd: number;
  day?: UsagePeriod;
  week?: UsagePeriod;
  allTime?: UsagePeriod;
}

export interface UsagePeriod {
  totalTokens: number;
  costUsd: number;
}

export interface Limits {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  sevenDayScoped?: ScopedLimit[];
  updatedAt: number;
}

export interface GoalState {
  active: boolean;
  elapsedSeconds?: number;
  startedAt?: number;
  updatedAt?: number;
}

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  effort?: { level?: string };
  model?: unknown;
  agent_type?: string;
  agent_id?: string;
  notification_type?: string;
  reason?: string;
  remote?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  usage_by_model?: Record<
    string,
    {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    }
  >;
}

export interface StatuslinePayload {
  session_id?: string;
  cwd?: string;
  permission_mode?: string;
  model?: { id?: string; display_name?: string };
  effort?: { level?: string };
  thinking?: { enabled?: boolean };
  fast_mode?: boolean;
  remote?: boolean;
  workspace?: { current_dir?: string; project_dir?: string };
  cost?: { total_cost_usd?: number };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
}

export interface UsageWindow {
  utilization?: number;
  resets_at?: string;
}

export interface UsageLimitEntry {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string;
  is_active?: boolean;
  scope?: {
    model?: { id?: string | null; display_name?: string | null } | null;
    surface?: unknown;
  } | null;
}

export interface UsageApiResponse {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  seven_day_opus?: UsageWindow;
  seven_day_sonnet?: UsageWindow;
  limits?: UsageLimitEntry[];
}

export interface PresenceState {
  planName: string;
  resetCreditsAvailable?: number;
  limits?: Limits;
  model?: ModelInfo;
  effort?: EffortLevel;
  action: string;
  status: SessionStatus;
  thinkingSeconds?: number;
  planMode: boolean;
  agentsRunning: number;
  agentsIdle: number;
  startTimestamp?: number;
  usage?: UsageTotals;
  costUsd?: number;
  costBreakdown?: CostBreakdown;
  monthlyUsage?: MonthlyUsage;
  remote?: boolean;
  contextPct?: number;
  realtime?: boolean;
  goalActive?: boolean;
  goalElapsedSeconds?: number;
  fastMode?: boolean;
}
