import {
  Issue,
  OrchestratorState,
  RunningEntry,
  RetryEntry,
  CodexTotals,
  CodexEvent,
  ServiceConfig,
} from "./types.js";
import { getSettings, validateDispatchConfig, maxConcurrentAgentsForState } from "./config.js";
import { createTrackerClient, TrackerClient } from "./tracker/index.js";
import { runAgent } from "./agent_runner.js";
import * as workspace from "./workspace.js";
import { logger } from "./logger.js";

const CONTINUATION_RETRY_DELAY_MS = 1000;
const FAILURE_RETRY_BASE_MS = 10000;

export class Orchestrator {
  private state: OrchestratorState;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private refreshRequested = false;

  constructor() {
    const config = getSettings();
    this.state = {
      poll_interval_ms: config.polling.interval_ms,
      max_concurrent_agents: config.agent.max_concurrent_agents,
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
      completed: new Set(),
      codex_totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 },
      codex_rate_limits: null,
    };
  }

  async start(): Promise<void> {
    this.running = true;

    const config = getSettings();
    const validationError = validateDispatchConfig(config);
    if (validationError) {
      throw new Error(`Startup validation failed: ${validationError}`);
    }

    await this.runTerminalWorkspaceCleanup();
    this.scheduleTick(0);
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }

    for (const [, entry] of this.state.running) {
      entry.worker_abort.abort();
    }
  }

  requestRefresh(): void {
    this.refreshRequested = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    this.scheduleTick(0);
  }

  getSnapshot(): OrchestratorSnapshot {
    const now = new Date();
    const runningEntries: RunningSnapshotEntry[] = [];
    let activeSeconds = 0;

    for (const [, entry] of this.state.running) {
      const elapsed = (now.getTime() - entry.started_at.getTime()) / 1000;
      activeSeconds += elapsed;
      runningEntries.push({
        issue_id: entry.issue_id,
        issue_identifier: entry.identifier,
        state: entry.issue.state,
        session_id: entry.session_id,
        turn_count: entry.turn_count,
        last_event: entry.last_codex_event,
        last_message: entry.last_codex_message,
        started_at: entry.started_at.toISOString(),
        last_event_at: entry.last_codex_timestamp?.toISOString() ?? null,
        tokens: {
          input_tokens: entry.codex_input_tokens,
          output_tokens: entry.codex_output_tokens,
          total_tokens: entry.codex_total_tokens,
        },
      });
    }

    const retryingEntries: RetrySnapshotEntry[] = [];
    for (const [, entry] of this.state.retry_attempts) {
      retryingEntries.push({
        issue_id: entry.issue_id,
        issue_identifier: entry.identifier,
        attempt: entry.attempt,
        due_at: new Date(entry.due_at_ms).toISOString(),
        error: entry.error,
      });
    }

    return {
      generated_at: now.toISOString(),
      counts: { running: runningEntries.length, retrying: retryingEntries.length },
      running: runningEntries,
      retrying: retryingEntries,
      codex_totals: {
        ...this.state.codex_totals,
        seconds_running: this.state.codex_totals.seconds_running + activeSeconds,
      },
      rate_limits: this.state.codex_rate_limits,
    };
  }

  getIssueDetail(identifier: string): IssueDetail | null {
    for (const [, entry] of this.state.running) {
      if (entry.identifier === identifier) {
        return {
          issue_identifier: entry.identifier,
          issue_id: entry.issue_id,
          status: "running",
          workspace: { path: workspace.workspacePath(getSettings(), entry.identifier) },
          running: {
            session_id: entry.session_id,
            turn_count: entry.turn_count,
            state: entry.issue.state,
            started_at: entry.started_at.toISOString(),
            last_event: entry.last_codex_event,
            last_message: entry.last_codex_message,
            last_event_at: entry.last_codex_timestamp?.toISOString() ?? null,
            tokens: {
              input_tokens: entry.codex_input_tokens,
              output_tokens: entry.codex_output_tokens,
              total_tokens: entry.codex_total_tokens,
            },
          },
          retry: null,
        };
      }
    }

    for (const [, entry] of this.state.retry_attempts) {
      if (entry.identifier === identifier) {
        return {
          issue_identifier: entry.identifier,
          issue_id: entry.issue_id,
          status: "retrying",
          workspace: { path: workspace.workspacePath(getSettings(), entry.identifier) },
          running: null,
          retry: {
            attempt: entry.attempt,
            due_at: new Date(entry.due_at_ms).toISOString(),
            error: entry.error,
          },
        };
      }
    }

    return null;
  }

  private scheduleTick(delayMs: number): void {
    if (!this.running) return;
    this.tickTimer = setTimeout(() => this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.refreshRequested = false;

    this.refreshRuntimeConfig();
    await this.reconcileRunningIssues();

    const config = getSettings();
    const validationError = validateDispatchConfig(config);
    if (validationError) {
      logger.error("dispatch_validation_failed", { error: validationError });
      this.scheduleTick(this.state.poll_interval_ms);
      return;
    }

    try {
      const client = this.createTrackerClient(config);
      const candidates = await client.fetchCandidateIssues();
      const sorted = this.sortForDispatch(candidates);

      for (const issue of sorted) {
        if (this.availableSlots() <= 0) break;
        if (this.shouldDispatch(issue, config)) {
          this.dispatchIssue(issue, null);
        }
      }
    } catch (err) {
      logger.error("candidate_fetch_failed", { error: String(err) });
    }

    this.scheduleTick(this.state.poll_interval_ms);
  }

  private refreshRuntimeConfig(): void {
    try {
      const config = getSettings();
      this.state.poll_interval_ms = config.polling.interval_ms;
      this.state.max_concurrent_agents = config.agent.max_concurrent_agents;
    } catch (err) {
      logger.warn("config_refresh_failed", { error: String(err) });
    }
  }

  private async reconcileRunningIssues(): Promise<void> {
    this.reconcileStalls();

    const runningIds = [...this.state.running.keys()];
    if (runningIds.length === 0) return;

    const config = getSettings();
    try {
      const client = this.createTrackerClient(config);
      const refreshed = await client.fetchIssueStatesByIds(runningIds);

      const refreshedMap = new Map(refreshed.map((i) => [i.id, i]));

      for (const issueId of runningIds) {
        const entry = this.state.running.get(issueId);
        if (!entry) continue;

        const refreshedIssue = refreshedMap.get(issueId);
        if (!refreshedIssue) continue;

        const terminalStates = config.tracker.terminal_states.map((s) => s.toLowerCase());
        const activeStates = config.tracker.active_states.map((s) => s.toLowerCase());
        const currentState = refreshedIssue.state.toLowerCase();

        if (terminalStates.includes(currentState)) {
          logger.info("reconcile_terminal", { issue_identifier: entry.identifier, state: refreshedIssue.state });
          entry.worker_abort.abort();
          this.removeRunning(issueId);
          await workspace.removeWorkspace(config, entry.identifier);
        } else if (activeStates.includes(currentState)) {
          entry.issue = refreshedIssue;
        } else {
          logger.info("reconcile_non_active", { issue_identifier: entry.identifier, state: refreshedIssue.state });
          entry.worker_abort.abort();
          this.removeRunning(issueId);
        }
      }
    } catch (err) {
      logger.debug("reconcile_state_refresh_failed", { error: String(err) });
    }
  }

  private reconcileStalls(): void {
    const config = getSettings();
    const stallTimeoutMs = config.codex.stall_timeout_ms;
    if (stallTimeoutMs <= 0) return;

    const now = Date.now();
    for (const [issueId, entry] of this.state.running) {
      const lastActivity = entry.last_codex_timestamp ?? entry.started_at;
      const elapsed = now - lastActivity.getTime();
      if (elapsed > stallTimeoutMs) {
        logger.warn("stall_detected", { issue_identifier: entry.identifier, elapsed_ms: elapsed });
        entry.worker_abort.abort();
        this.removeRunning(issueId);
        this.scheduleRetry(issueId, entry.identifier, (entry.retry_attempt ?? 0) + 1, "stall detected");
      }
    }
  }

  private shouldDispatch(issue: Issue, config: ServiceConfig): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;

    const activeStates = config.tracker.active_states.map((s) => s.toLowerCase());
    const terminalStates = config.tracker.terminal_states.map((s) => s.toLowerCase());
    const state = issue.state.toLowerCase();

    if (!activeStates.includes(state)) return false;
    if (terminalStates.includes(state)) return false;
    if (this.state.running.has(issue.id)) return false;
    if (this.state.claimed.has(issue.id)) return false;

    if (this.availableSlots() <= 0) return false;

    const stateLimit = maxConcurrentAgentsForState(config, issue.state);
    const stateCount = this.countByState(issue.state);
    if (stateCount >= stateLimit) return false;

    if (state === "todo" && this.hasNonTerminalBlockers(issue, terminalStates)) return false;

    return true;
  }

  private hasNonTerminalBlockers(issue: Issue, terminalStates: string[]): boolean {
    for (const blocker of issue.blocked_by) {
      const blockerState = blocker.state?.toLowerCase();
      if (!blockerState || !terminalStates.includes(blockerState)) {
        return true;
      }
    }
    return false;
  }

  private dispatchIssue(issue: Issue, attempt: number | null): void {
    const abort = new AbortController();

    const workerPromise = this.runWorker(issue, attempt, abort.signal);

    const entry: RunningEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      issue,
      session_id: null,
      codex_app_server_pid: null,
      last_codex_message: null,
      last_codex_event: null,
      last_codex_timestamp: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      retry_attempt: attempt,
      started_at: new Date(),
      turn_count: 0,
      worker_abort: abort,
      worker_promise: workerPromise,
    };

    this.state.running.set(issue.id, entry);
    this.state.claimed.add(issue.id);

    const existingRetry = this.state.retry_attempts.get(issue.id);
    if (existingRetry) {
      clearTimeout(existingRetry.timer_handle);
      this.state.retry_attempts.delete(issue.id);
    }

    logger.info("dispatch_issue", { issue_id: issue.id, issue_identifier: issue.identifier, attempt });
  }

  private async runWorker(issue: Issue, attempt: number | null, signal: AbortSignal): Promise<void> {
    try {
      await runAgent(issue, {
        attempt,
        signal,
        onCodexUpdate: (issueId, event) => this.handleCodexUpdate(issueId, event),
      });
      this.onWorkerExit(issue.id, "normal");
    } catch (err) {
      if (signal.aborted) {
        this.onWorkerExit(issue.id, "cancelled");
      } else {
        logger.error("worker_failed", { issue_id: issue.id, issue_identifier: issue.identifier, error: String(err) });
        this.onWorkerExit(issue.id, "error", String(err));
      }
    }
  }

  private handleCodexUpdate(issueId: string, event: CodexEvent): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    entry.last_codex_event = event.event;
    entry.last_codex_timestamp = event.timestamp;

    if (event.event === "session_started") {
      entry.session_id = event.payload?.session_id as string ?? null;
      entry.codex_app_server_pid = event.codex_app_server_pid ?? null;
      entry.turn_count++;
    }

    if (event.event === "turn_completed") {
      entry.turn_count++;
    }

    if (event.payload?.payload) {
      const payload = event.payload.payload as Record<string, unknown>;
      this.extractTokenUsage(entry, payload);
      this.extractRateLimits(payload);
    }

    const message = this.humanizeEvent(event);
    if (message) entry.last_codex_message = message;
  }

  private extractTokenUsage(entry: RunningEntry, payload: Record<string, unknown>): void {
    const method = payload.method as string | undefined;

    if (method === "thread/tokenUsage/updated") {
      const params = payload.params as Record<string, unknown> | undefined;
      const usage = params?.totalTokenUsage as Record<string, unknown> | undefined;
      if (usage) {
        const input = (usage.inputTokens as number) ?? (usage.input_tokens as number) ?? 0;
        const output = (usage.outputTokens as number) ?? (usage.output_tokens as number) ?? 0;
        const total = (usage.totalTokens as number) ?? (usage.total_tokens as number) ?? (input + output);

        const deltaInput = input - entry.last_reported_input_tokens;
        const deltaOutput = output - entry.last_reported_output_tokens;
        const deltaTotal = total - entry.last_reported_total_tokens;

        if (deltaInput > 0) this.state.codex_totals.input_tokens += deltaInput;
        if (deltaOutput > 0) this.state.codex_totals.output_tokens += deltaOutput;
        if (deltaTotal > 0) this.state.codex_totals.total_tokens += deltaTotal;

        entry.codex_input_tokens = input;
        entry.codex_output_tokens = output;
        entry.codex_total_tokens = total;
        entry.last_reported_input_tokens = input;
        entry.last_reported_output_tokens = output;
        entry.last_reported_total_tokens = total;
      }
    }
  }

  private extractRateLimits(payload: Record<string, unknown>): void {
    const method = payload.method as string | undefined;
    if (method === "thread/rateLimits/updated") {
      const params = payload.params as Record<string, unknown> | undefined;
      if (params) {
        this.state.codex_rate_limits = params;
      }
    }
  }

  private humanizeEvent(event: CodexEvent): string | null {
    switch (event.event) {
      case "session_started": return "Session started";
      case "turn_completed": return "Turn completed";
      case "turn_failed": return "Turn failed";
      case "notification": return null;
      case "approval_auto_approved": return "Auto-approved";
      default: return null;
    }
  }

  private onWorkerExit(issueId: string, reason: "normal" | "error" | "cancelled", error?: string): void {
    const entry = this.state.running.get(issueId);
    if (!entry) return;

    this.addRuntimeSeconds(entry);
    this.removeRunning(issueId);

    if (reason === "normal") {
      this.state.completed.add(issueId);
      this.scheduleRetry(issueId, entry.identifier, 1, null);
    } else if (reason === "cancelled") {
      this.state.claimed.delete(issueId);
    } else {
      const nextAttempt = (entry.retry_attempt ?? 0) + 1;
      this.scheduleRetry(issueId, entry.identifier, nextAttempt, error ?? "worker error");
    }
  }

  private removeRunning(issueId: string): void {
    this.state.running.delete(issueId);
  }

  private addRuntimeSeconds(entry: RunningEntry): void {
    const elapsed = (Date.now() - entry.started_at.getTime()) / 1000;
    this.state.codex_totals.seconds_running += elapsed;
  }

  private scheduleRetry(issueId: string, identifier: string, attempt: number, error: string | null): void {
    const existing = this.state.retry_attempts.get(issueId);
    if (existing) {
      clearTimeout(existing.timer_handle);
    }

    const config = getSettings();
    const delayMs = error === null
      ? CONTINUATION_RETRY_DELAY_MS
      : Math.min(FAILURE_RETRY_BASE_MS * Math.pow(2, attempt - 1), config.agent.max_retry_backoff_ms);

    const dueAtMs = Date.now() + delayMs;
    const timerHandle = setTimeout(() => this.onRetryTimer(issueId), delayMs);

    const retryEntry: RetryEntry = {
      issue_id: issueId,
      identifier,
      attempt,
      due_at_ms: dueAtMs,
      timer_handle: timerHandle,
      error,
    };

    this.state.retry_attempts.set(issueId, retryEntry);
    logger.info("retry_scheduled", { issue_id: issueId, issue_identifier: identifier, attempt, delay_ms: delayMs, error });
  }

  private async onRetryTimer(issueId: string): Promise<void> {
    const retryEntry = this.state.retry_attempts.get(issueId);
    if (!retryEntry) return;
    this.state.retry_attempts.delete(issueId);

    const config = getSettings();
    try {
      const client = this.createTrackerClient(config);
      const candidates = await client.fetchCandidateIssues();
      const issue = candidates.find((i) => i.id === issueId);

      if (!issue) {
        this.state.claimed.delete(issueId);
        logger.info("retry_released", { issue_id: issueId, issue_identifier: retryEntry.identifier });
        return;
      }

      if (this.availableSlots() <= 0) {
        this.scheduleRetry(issueId, issue.identifier, retryEntry.attempt + 1, "no available orchestrator slots");
        return;
      }

      this.dispatchIssue(issue, retryEntry.attempt);
    } catch (err) {
      this.scheduleRetry(issueId, retryEntry.identifier, retryEntry.attempt + 1, `retry poll failed: ${err}`);
    }
  }

  private availableSlots(): number {
    return Math.max(this.state.max_concurrent_agents - this.state.running.size, 0);
  }

  private countByState(state: string): number {
    const normalizedState = state.toLowerCase();
    let count = 0;
    for (const [, entry] of this.state.running) {
      if (entry.issue.state.toLowerCase() === normalizedState) count++;
    }
    return count;
  }

  private sortForDispatch(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;

      const ca = a.created_at?.getTime() ?? Infinity;
      const cb = b.created_at?.getTime() ?? Infinity;
      if (ca !== cb) return ca - cb;

      return a.identifier.localeCompare(b.identifier);
    });
  }

  private async runTerminalWorkspaceCleanup(): Promise<void> {
    const config = getSettings();
    try {
      const client = this.createTrackerClient(config);
      const terminalIssues = await client.fetchIssuesByStates(config.tracker.terminal_states);
      for (const issue of terminalIssues) {
        await workspace.removeWorkspace(config, issue.identifier).catch((err) => {
          logger.debug("terminal_cleanup_failed", { identifier: issue.identifier, error: String(err) });
        });
      }
      logger.info("terminal_workspace_cleanup", { count: terminalIssues.length });
    } catch (err) {
      logger.warn("terminal_cleanup_fetch_failed", { error: String(err) });
    }
  }

  private createTrackerClient(config: ServiceConfig): TrackerClient {
    return createTrackerClient(config);
  }
}

export interface OrchestratorSnapshot {
  generated_at: string;
  counts: { running: number; retrying: number };
  running: RunningSnapshotEntry[];
  retrying: RetrySnapshotEntry[];
  codex_totals: CodexTotals;
  rate_limits: Record<string, unknown> | null;
}

interface RunningSnapshotEntry {
  issue_id: string;
  issue_identifier: string;
  state: string;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  last_event_at: string | null;
  tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
}

interface RetrySnapshotEntry {
  issue_id: string;
  issue_identifier: string;
  attempt: number;
  due_at: string;
  error: string | null;
}

interface IssueDetail {
  issue_identifier: string;
  issue_id: string;
  status: string;
  workspace: { path: string };
  running: {
    session_id: string | null;
    turn_count: number;
    state: string;
    started_at: string;
    last_event: string | null;
    last_message: string | null;
    last_event_at: string | null;
    tokens: { input_tokens: number; output_tokens: number; total_tokens: number };
  } | null;
  retry: {
    attempt: number;
    due_at: string;
    error: string | null;
  } | null;
}
