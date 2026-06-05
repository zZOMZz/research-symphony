import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { Issue, ServiceConfig, CodexEvent } from "../types.js";
import { logger } from "../logger.js";
import { resolveDefaultTurnSandboxPolicy } from "../config.js";

const NON_INTERACTIVE_ANSWER = "This is a non-interactive session. Operator input is unavailable.";

export interface AppServerSession {
  process: ChildProcess;
  rl: readline.Interface;
  thread_id: string;
  workspace: string;
  config: ServiceConfig;
  pid: string | null;
}

export interface TurnResult {
  session_id: string;
  thread_id: string;
  turn_id: string;
  result: "turn_completed" | "turn_failed" | "turn_cancelled";
}

type OnMessage = (event: CodexEvent) => void;
type ToolExecutor = (toolName: string | null, args: Record<string, unknown>) => { success: boolean; output: string; contentItems?: unknown[] };

export async function startSession(
  workspace: string,
  config: ServiceConfig,
): Promise<AppServerSession> {
  const child = spawn("bash", ["-lc", config.codex.command], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  const pid = child.pid ? String(child.pid) : null;

  const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });

  const session: AppServerSession = {
    process: child,
    rl,
    thread_id: "",
    workspace,
    config,
    pid,
  };

  child.stderr?.on("data", (data: Buffer) => {
    logger.debug("codex_stderr", { data: data.toString().slice(0, 500) });
  });

  await sendInitialize(session);
  const threadId = await startThread(session);
  session.thread_id = threadId;

  return session;
}

export async function runTurn(
  session: AppServerSession,
  prompt: string,
  issue: Issue,
  onMessage: OnMessage,
  toolExecutor?: ToolExecutor,
): Promise<TurnResult> {
  const turnId = await startTurn(session, prompt, issue);
  const sessionId = `${session.thread_id}-${turnId}`;

  emitEvent(onMessage, "session_started", {
    session_id: sessionId,
    thread_id: session.thread_id,
    turn_id: turnId,
    codex_app_server_pid: session.pid,
  });

  const result = await awaitTurnCompletion(session, onMessage, toolExecutor);

  return {
    session_id: sessionId,
    thread_id: session.thread_id,
    turn_id: turnId,
    result,
  };
}

export function stopSession(session: AppServerSession): void {
  try {
    session.rl.close();
    session.process.stdin?.end();
    session.process.kill("SIGTERM");
    setTimeout(() => {
      try { session.process.kill("SIGKILL"); } catch {}
    }, 5000);
  } catch {}
}

async function sendInitialize(session: AppServerSession): Promise<void> {
  const payload = {
    method: "initialize",
    id: 1,
    params: {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "symphony-orchestrator",
        title: "Symphony Orchestrator",
        version: "0.1.0",
      },
    },
  };

  sendMessage(session, payload);
  await awaitResponse(session, 1);
  sendMessage(session, { method: "initialized", params: {} });
}

async function startThread(session: AppServerSession): Promise<string> {
  const config = session.config;
  const payload = {
    method: "thread/start",
    id: 2,
    params: {
      approvalPolicy: config.codex.approval_policy,
      sandbox: config.codex.thread_sandbox,
      cwd: session.workspace,
      dynamicTools: getToolSpecs(config),
    },
  };

  sendMessage(session, payload);
  const response = await awaitResponse(session, 2) as any;

  const threadId = response?.thread?.id;
  if (!threadId) {
    throw new AppServerError("invalid_thread_payload", "Missing thread.id in response");
  }
  return threadId;
}

async function startTurn(session: AppServerSession, prompt: string, issue: Issue): Promise<string> {
  const config = session.config;
  const turnSandboxPolicy = resolveDefaultTurnSandboxPolicy(config, session.workspace);

  const payload = {
    method: "turn/start",
    id: 3,
    params: {
      threadId: session.thread_id,
      input: [{ type: "text", text: prompt }],
      cwd: session.workspace,
      title: `${issue.identifier}: ${issue.title}`,
      approvalPolicy: config.codex.approval_policy,
      sandboxPolicy: turnSandboxPolicy,
    },
  };

  sendMessage(session, payload);
  const response = await awaitResponse(session, 3) as any;

  const turnId = response?.turn?.id;
  if (!turnId) {
    throw new AppServerError("invalid_turn_payload", "Missing turn.id in response");
  }
  return turnId;
}

async function awaitTurnCompletion(
  session: AppServerSession,
  onMessage: OnMessage,
  toolExecutor?: ToolExecutor,
): Promise<"turn_completed" | "turn_failed" | "turn_cancelled"> {
  const timeoutMs = session.config.codex.turn_timeout_ms;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new AppServerError("turn_timeout", `Turn timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const handleLine = (line: string) => {
      if (resolved) return;
      try {
        handleTurnMessage(session, line, onMessage, toolExecutor, (result) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            session.rl.off("line", handleLine);
            session.rl.off("close", handleClose);
            resolve(result);
          }
        }, (err) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            session.rl.off("line", handleLine);
            session.rl.off("close", handleClose);
            reject(err);
          }
        });
      } catch (err) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          session.rl.off("line", handleLine);
          session.rl.off("close", handleClose);
          reject(err);
        }
      }
    };

    const handleClose = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new AppServerError("port_exit", "App server process exited"));
      }
    };

    session.rl.on("line", handleLine);
    session.rl.on("close", handleClose);
  });
}

function handleTurnMessage(
  session: AppServerSession,
  line: string,
  onMessage: OnMessage,
  toolExecutor: ToolExecutor | undefined,
  onComplete: (result: "turn_completed" | "turn_failed" | "turn_cancelled") => void,
  onError: (err: Error) => void,
): void {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(line);
  } catch {
    if (line.includes('"method"') || line.includes('"id"')) {
      emitEvent(onMessage, "malformed", { raw: line.slice(0, 1000) });
    }
    return;
  }

  const method = payload.method as string | undefined;

  if (method === "turn/completed") {
    emitEvent(onMessage, "turn_completed", { payload });
    onComplete("turn_completed");
    return;
  }

  if (method === "turn/failed") {
    emitEvent(onMessage, "turn_failed", { payload, params: payload.params });
    onError(new AppServerError("turn_failed", `Turn failed: ${JSON.stringify(payload.params)}`));
    return;
  }

  if (method === "turn/cancelled") {
    emitEvent(onMessage, "turn_cancelled", { payload, params: payload.params });
    onError(new AppServerError("turn_cancelled", "Turn was cancelled"));
    return;
  }

  if (method && payload.id != null) {
    handleApprovalOrTool(session, method, payload, onMessage, toolExecutor, onError);
    return;
  }

  emitEvent(onMessage, "notification", { payload, method });
}

function handleApprovalOrTool(
  session: AppServerSession,
  method: string,
  payload: Record<string, unknown>,
  onMessage: OnMessage,
  toolExecutor: ToolExecutor | undefined,
  onError: (err: Error) => void,
): void {
  const id = payload.id;
  const autoApprove = session.config.codex.approval_policy === "never";

  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    if (autoApprove) {
      const decision = method.startsWith("item/") ? "acceptForSession" : "approved_for_session";
      sendMessage(session, { id, result: { decision } });
      emitEvent(onMessage, "approval_auto_approved", { payload, decision });
    } else {
      emitEvent(onMessage, "turn_input_required", { payload });
      onError(new AppServerError("turn_input_required", "Approval required but auto-approve is off"));
    }
    return;
  }

  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    if (autoApprove) {
      const decision = method.startsWith("item/") ? "acceptForSession" : "approved_for_session";
      sendMessage(session, { id, result: { decision } });
      emitEvent(onMessage, "approval_auto_approved", { payload, decision });
    } else {
      emitEvent(onMessage, "turn_input_required", { payload });
      onError(new AppServerError("turn_input_required", "Approval required but auto-approve is off"));
    }
    return;
  }

  if (method === "item/tool/call") {
    const params = payload.params as Record<string, unknown> | undefined;
    const toolName = extractToolName(params);
    const args = extractToolArguments(params);

    let result: { success: boolean; output: string; contentItems?: unknown[] };
    if (toolExecutor && toolName) {
      result = toolExecutor(toolName, args);
    } else {
      result = { success: false, output: `Unsupported tool: ${toolName ?? "unknown"}` };
    }

    const contentItems = result.contentItems ?? [{ type: "inputText", text: result.output }];
    sendMessage(session, { id, result: { success: result.success, output: result.output, contentItems } });

    const eventName = result.success ? "notification" : "unsupported_tool_call";
    emitEvent(onMessage, eventName, { payload, tool: toolName });
    return;
  }

  if (method === "item/tool/requestUserInput") {
    const params = payload.params as Record<string, unknown> | undefined;
    const answers = buildNonInteractiveAnswers(params);
    if (answers) {
      sendMessage(session, { id, result: { answers } });
      emitEvent(onMessage, "notification", { payload, auto_answered: true });
    } else {
      emitEvent(onMessage, "turn_input_required", { payload });
      onError(new AppServerError("turn_input_required", "User input required in non-interactive session"));
    }
    return;
  }

  if (needsInput(method, payload)) {
    emitEvent(onMessage, "turn_input_required", { payload });
    onError(new AppServerError("turn_input_required", `Input required for method: ${method}`));
    return;
  }

  emitEvent(onMessage, "notification", { payload, method });
}

function buildNonInteractiveAnswers(params: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const questions = params?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const answers: Record<string, unknown> = {};
  for (const q of questions) {
    const qId = q?.id;
    if (typeof qId !== "string") return null;

    const options = q?.options;
    if (Array.isArray(options) && options.length > 0) {
      const approveOption = options.find((o: Record<string, unknown>) => {
        const label = o?.label;
        if (typeof label !== "string") return false;
        const lower = label.trim().toLowerCase();
        return lower === "approve this session" || lower === "approve once" || lower.startsWith("approve") || lower.startsWith("allow");
      });
      if (approveOption) {
        answers[qId] = { answers: [approveOption.label] };
      } else {
        answers[qId] = { answers: [NON_INTERACTIVE_ANSWER] };
      }
    } else {
      answers[qId] = { answers: [NON_INTERACTIVE_ANSWER] };
    }
  }
  return answers;
}

function needsInput(method: string, _payload: Record<string, unknown>): boolean {
  return method.includes("requestInput") || method.includes("requestUserInput") || method.includes("requestApproval");
}

function extractToolName(params: Record<string, unknown> | undefined): string | null {
  if (!params) return null;
  const tool = params.tool as Record<string, unknown> | undefined;
  if (tool?.name && typeof tool.name === "string") return tool.name;
  if (params.name && typeof params.name === "string") return params.name as string;
  return null;
}

function extractToolArguments(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!params) return {};
  const tool = params.tool as Record<string, unknown> | undefined;
  if (tool?.arguments && typeof tool.arguments === "object") return tool.arguments as Record<string, unknown>;
  if (params.arguments && typeof params.arguments === "object") return params.arguments as Record<string, unknown>;
  return {};
}

function getToolSpecs(config: ServiceConfig): unknown[] {
  if (config.tracker.kind === "linear" && config.tracker.api_key) {
    return [
      {
        name: "linear_graphql",
        description: "Execute a raw GraphQL query or mutation against Linear.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "GraphQL query or mutation" },
            variables: { type: "object", description: "GraphQL variables" },
          },
          required: ["query"],
        },
      },
    ];
  }
  return [];
}

async function awaitResponse(session: AppServerSession, requestId: number): Promise<Record<string, unknown>> {
  const timeoutMs = session.config.codex.read_timeout_ms;

  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        session.rl.off("line", handleLine);
        reject(new AppServerError("response_timeout", `Response timeout for request ${requestId}`));
      }
    }, timeoutMs);

    const handleLine = (line: string) => {
      if (resolved) return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(line);
      } catch {
        return;
      }

      if (payload.id === requestId) {
        resolved = true;
        clearTimeout(timer);
        session.rl.off("line", handleLine);
        if (payload.error) {
          reject(new AppServerError("response_error", `Error response: ${JSON.stringify(payload.error)}`));
        } else {
          resolve((payload.result as Record<string, unknown>) ?? {});
        }
      }
    };

    session.rl.on("line", handleLine);
  });
}

function sendMessage(session: AppServerSession, payload: unknown): void {
  const line = JSON.stringify(payload) + "\n";
  session.process.stdin?.write(line);
}

function emitEvent(onMessage: OnMessage, event: string, data: Record<string, unknown>): void {
  onMessage({
    event,
    timestamp: new Date(),
    codex_app_server_pid: data.codex_app_server_pid as string | undefined,
    usage: data.usage as { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined,
    payload: data,
  });
}

export class AppServerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppServerError";
  }
}
