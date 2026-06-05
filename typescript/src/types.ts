export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: Date | null;
  updated_at: Date | null;
}

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

export interface RunningEntry {
  issue_id: string;
  identifier: string;
  issue: Issue;
  session_id: string | null;
  codex_app_server_pid: string | null;
  last_codex_message: string | null;
  last_codex_event: string | null;
  last_codex_timestamp: Date | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  last_reported_input_tokens: number;
  last_reported_output_tokens: number;
  last_reported_total_tokens: number;
  retry_attempt: number | null;
  started_at: Date;
  turn_count: number;
  worker_abort: AbortController;
  worker_promise: Promise<void>;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: ReturnType<typeof setTimeout>;
  error: string | null;
}

export interface CodexTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seconds_running: number;
}

export interface OrchestratorState {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
  codex_totals: CodexTotals;
  codex_rate_limits: Record<string, unknown> | null;
}

export interface CodexEvent {
  event: string;
  timestamp: Date;
  codex_app_server_pid?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  payload?: Record<string, unknown>;
}

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  api_key: string | null;
  project_slug: string | null;
  active_states: string[];
  terminal_states: string[];
}

export interface PollingConfig {
  interval_ms: number;
}

export interface WorkspaceConfig {
  root: string;
}

export interface HooksConfig {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
}

export interface AgentConfig {
  max_concurrent_agents: number;
  max_turns: number;
  max_retry_backoff_ms: number;
  max_concurrent_agents_by_state: Record<string, number>;
  backend: string;
}

export interface CodexConfig {
  command: string;
  approval_policy: string | Record<string, unknown>;
  thread_sandbox: string;
  turn_sandbox_policy: Record<string, unknown> | null;
  turn_timeout_ms: number;
  read_timeout_ms: number;
  stall_timeout_ms: number;
}

export interface ClaudeCodeConfig {
  command: string;
  model: string | null;
  max_turns: number | null;
  allowed_tools: string[];
}

export interface ServerConfig {
  port: number | null;
  host: string;
}

export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  claude_code: ClaudeCodeConfig;
  server: ServerConfig;
}
