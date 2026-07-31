export type Tristate = boolean | null;

export interface GatewayState {
  authenticated: Tristate;
  healthy: Tristate;
  /** Port Express is bound to, reported by /health (differs from the dev server port). */
  port: number | null;
  error: string | null;
  updatedAt: Date | null;
}

export interface TelemetryTotals {
  requests: number;
  success: number;
  failed: number;
  canceled: number;
  in_flight: number;
  success_rate: number | null;
}

export interface LatencySummary {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface TelemetryPoint {
  timestamp: string;
  success: number;
  failed: number;
  canceled: number;
  p95_latency_ms?: number | null;
}

export interface ModelTelemetry {
  model: string;
  requests: number;
  success: number;
  failed: number;
  canceled: number;
  success_rate: number | null;
  p95_latency_ms: number | null;
}

export interface ErrorTelemetry {
  type: string;
  count: number;
}

export interface RecentFailure {
  request_id: string;
  route?: string;
  method?: string;
  model: string | null;
  stream: boolean;
  outcome: 'failure' | 'canceled';
  status: number | null;
  error_type: string | null;
  duration_ms: number | null;
  timestamp: string;
}

export interface TelemetrySnapshot {
  generated_at: string;
  process_started_at?: string;
  window_minutes: number;
  retention_minutes: number;
  max_events?: number;
  totals: TelemetryTotals;
  latency_ms: LatencySummary;
  series: TelemetryPoint[];
  by_model: ModelTelemetry[];
  by_error: ErrorTelemetry[];
  recent_failures: RecentFailure[];
}

/** One second of traffic, as pushed by the SSE `tick` frame. */
export interface LiveSample {
  /** Bucket start, epoch milliseconds. */
  t: number;
  ok: number;
  fail: number;
  hold: number;
  p95: number | null;
  in_flight?: number;
}

export interface TelemetryInitFrame {
  snapshot: TelemetrySnapshot;
  live: LiveSample[];
  tick_interval_ms: number;
}

export type StreamStatus = 'connecting' | 'live' | 'offline';

export interface KiroSource {
  id: string;
  label: string;
  provider: string | null;
  authType: 'social' | 'sso' | null;
  expiresAt: string | null;
  expired: boolean | null;
  hasProfileArn: boolean;
}

export interface ClaudeConfigValues {
  baseUrl: string;
  authToken: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  subagentModel: string;
}

export interface ClaudeConfigState {
  settingsPath: string;
  exists: boolean;
  error?: string | null;
  current: Partial<ClaudeConfigValues> | null;
  models: string[];
  suggestedBaseUrl: string;
  defaults: ClaudeConfigValues;
}
