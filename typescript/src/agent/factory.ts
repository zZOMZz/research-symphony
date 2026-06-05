import { ServiceConfig } from "../types.js";
import { AgentBackend } from "./interface.js";
import { CodexBackend } from "./codex_backend.js";
import { ClaudeCodeBackend } from "./claude_code_backend.js";

export function createAgentBackend(config: ServiceConfig): AgentBackend {
  const backend = config.agent.backend;

  switch (backend) {
    case "codex":
      return new CodexBackend();
    case "claude-code":
      return new ClaudeCodeBackend();
    default:
      throw new Error(`Unsupported agent backend: ${backend}`);
  }
}

export type { AgentBackend, AgentSession, TurnResult } from "./interface.js";
