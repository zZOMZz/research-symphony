import { Issue, ServiceConfig, CodexEvent } from "../types.js";

export interface AgentSession {
  runTurn(prompt: string, issue: Issue, onEvent: (event: CodexEvent) => void): Promise<TurnResult>;
  stop(): void;
}

export interface TurnResult {
  session_id: string;
  thread_id: string;
  turn_id: string;
  result: "turn_completed" | "turn_failed" | "turn_cancelled";
}

export interface AgentBackend {
  startSession(workspace: string, config: ServiceConfig): Promise<AgentSession>;
}
