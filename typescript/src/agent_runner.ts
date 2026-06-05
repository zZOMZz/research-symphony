import { Issue, ServiceConfig, CodexEvent } from "./types.js";
import { getSettings } from "./config.js";
import { buildPrompt } from "./prompt.js";
import { createTrackerClient, TrackerClient } from "./tracker/index.js";
import { createAgentBackend, AgentBackend, AgentSession } from "./agent/index.js";
import * as workspace from "./workspace.js";
import { logger } from "./logger.js";

export interface AgentRunOptions {
  attempt?: number | null;
  onCodexUpdate?: (issueId: string, event: CodexEvent) => void;
  signal?: AbortSignal;
}

export async function runAgent(issue: Issue, opts: AgentRunOptions = {}): Promise<void> {
  const config = getSettings();
  const { attempt, onCodexUpdate, signal } = opts;

  logger.info("agent_run_start", { issue_id: issue.id, issue_identifier: issue.identifier });

  const ws = await workspace.createForIssue(config, issue.identifier);
  logger.info("workspace_ready", { issue_identifier: issue.identifier, workspace: ws.path, created: ws.created_now });

  try {
    await workspace.runBeforeRunHook(config, ws.path);

    if (signal?.aborted) {
      throw new Error("Cancelled before agent session start");
    }

    await runAgentTurns(config, ws.path, issue, attempt ?? null, onCodexUpdate, signal);
  } finally {
    await workspace.runAfterRunHook(config, ws.path);
  }
}

async function runAgentTurns(
  config: ServiceConfig,
  wsPath: string,
  issue: Issue,
  attempt: number | null,
  onCodexUpdate: ((issueId: string, event: CodexEvent) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const maxTurns = config.agent.max_turns;
  const backend: AgentBackend = createAgentBackend(config);
  const tracker: TrackerClient = createTrackerClient(config);
  let session: AgentSession | null = null;

  try {
    session = await backend.startSession(wsPath, config);

    let turnNumber = 1;
    let currentIssue = issue;

    while (true) {
      if (signal?.aborted) break;

      const prompt = buildTurnPrompt(currentIssue, attempt, turnNumber, maxTurns);
      const onMessage = (event: CodexEvent): void => {
        if (onCodexUpdate) onCodexUpdate(issue.id, event);
      };

      await session.runTurn(prompt, currentIssue, onMessage);

      const refreshedIssue = await refreshIssueState(tracker, issue.id);
      if (refreshedIssue) {
        currentIssue = refreshedIssue;
      }

      const activeStates = config.tracker.active_states.map((s) => s.toLowerCase());
      if (!activeStates.includes(currentIssue.state.toLowerCase())) {
        break;
      }

      if (turnNumber >= maxTurns) {
        logger.info("max_turns_reached", { issue_identifier: issue.identifier, max_turns: maxTurns });
        break;
      }

      turnNumber++;
    }
  } finally {
    if (session) {
      session.stop();
    }
  }
}

function buildTurnPrompt(issue: Issue, attempt: number | null, turnNumber: number, maxTurns: number): string {
  if (turnNumber === 1) {
    return buildPrompt(issue, { attempt });
  }

  return `Continue working on this issue. You are on turn ${turnNumber}/${maxTurns}. The issue is still in an active state (${issue.state}). Continue where you left off.`;
}

async function refreshIssueState(tracker: TrackerClient, issueId: string): Promise<Issue | null> {
  try {
    const issues = await tracker.fetchIssueStatesByIds([issueId]);
    return issues.length > 0 ? issues[0] : null;
  } catch (err) {
    logger.warn("issue_state_refresh_failed", { issue_id: issueId, error: String(err) });
    return null;
  }
}
