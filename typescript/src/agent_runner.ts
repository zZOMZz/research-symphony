import { Issue, ServiceConfig, CodexEvent } from "./types.js";
import { getSettings } from "./config.js";
import { buildPrompt } from "./prompt.js";
import { LinearClient } from "./linear/client.js";
import * as workspace from "./workspace.js";
import * as appServer from "./codex/app_server.js";
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

    await runCodexTurns(config, ws.path, issue, attempt ?? null, onCodexUpdate, signal);
  } finally {
    await workspace.runAfterRunHook(config, ws.path);
  }
}

async function runCodexTurns(
  config: ServiceConfig,
  wsPath: string,
  issue: Issue,
  attempt: number | null,
  onCodexUpdate: ((issueId: string, event: CodexEvent) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const maxTurns = config.agent.max_turns;
  let session: appServer.AppServerSession | null = null;

  try {
    session = await appServer.startSession(wsPath, config);

    let turnNumber = 1;
    let currentIssue = issue;

    while (true) {
      if (signal?.aborted) break;

      const prompt = buildTurnPrompt(currentIssue, attempt, turnNumber, maxTurns);
      const onMessage = (event: CodexEvent): void => {
        if (onCodexUpdate) onCodexUpdate(issue.id, event);
      };

      const toolExecutor = createToolExecutor(config);

      await appServer.runTurn(session, prompt, currentIssue, onMessage, toolExecutor);

      const refreshedIssue = await refreshIssueState(config, issue.id);
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
      appServer.stopSession(session);
    }
  }
}

function buildTurnPrompt(issue: Issue, attempt: number | null, turnNumber: number, maxTurns: number): string {
  if (turnNumber === 1) {
    return buildPrompt(issue, { attempt });
  }

  return `Continue working on this issue. You are on turn ${turnNumber}/${maxTurns}. The issue is still in an active state (${issue.state}). Continue where you left off.`;
}

async function refreshIssueState(config: ServiceConfig, issueId: string): Promise<Issue | null> {
  try {
    const client = new LinearClient({
      endpoint: config.tracker.endpoint,
      api_key: config.tracker.api_key!,
      project_slug: config.tracker.project_slug!,
      active_states: config.tracker.active_states,
      terminal_states: config.tracker.terminal_states,
    });
    const issues = await client.fetchIssueStatesByIds([issueId]);
    return issues.length > 0 ? issues[0] : null;
  } catch (err) {
    logger.warn("issue_state_refresh_failed", { issue_id: issueId, error: String(err) });
    return null;
  }
}

function createToolExecutor(config: ServiceConfig) {
  return (toolName: string | null, args: Record<string, unknown>): { success: boolean; output: string } => {
    if (toolName === "linear_graphql" && config.tracker.kind === "linear" && config.tracker.api_key) {
      return { success: false, output: "linear_graphql tool is async-only in this implementation; use direct API." };
    }
    return { success: false, output: `Unsupported tool: ${toolName ?? "unknown"}` };
  };
}
