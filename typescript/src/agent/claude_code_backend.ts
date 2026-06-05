import { spawn, ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { Issue, ServiceConfig, CodexEvent } from "../types.js";
import { AgentBackend, AgentSession, TurnResult } from "./interface.js";
import { logger } from "../logger.js";

interface ClaudeCodeSessionConfig {
  command: string;
  model: string | null;
  max_turns: number | null;
  allowed_tools: string[];
}

export class ClaudeCodeBackend implements AgentBackend {
  async startSession(workspace: string, config: ServiceConfig): Promise<AgentSession> {
    const ccConfig = getClaudeCodeConfig(config);
    return new ClaudeCodeSession(workspace, ccConfig);
  }
}

class ClaudeCodeSession implements AgentSession {
  private workspace: string;
  private config: ClaudeCodeSessionConfig;
  private process: ChildProcess | null = null;

  constructor(workspace: string, config: ClaudeCodeSessionConfig) {
    this.workspace = workspace;
    this.config = config;
  }

  async runTurn(prompt: string, issue: Issue, onEvent: (event: CodexEvent) => void): Promise<TurnResult> {
    const args = this.buildArgs(prompt, issue);

    const child = spawn(this.config.command, args, {
      cwd: this.workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });

    this.process = child;
    const turnId = `turn-${Date.now()}`;
    const threadId = `claude-${issue.identifier}`;
    const sessionId = `${threadId}-${turnId}`;

    onEvent({
      event: "session_started",
      timestamp: new Date(),
      codex_app_server_pid: child.pid ? String(child.pid) : undefined,
      payload: { session_id: sessionId, thread_id: threadId, turn_id: turnId },
    });

    return new Promise((resolve, reject) => {
      let output = "";

      const rl = readline.createInterface({ input: child.stdout! });

      rl.on("line", (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "result" || msg.type === "assistant") {
            onEvent({
              event: "notification",
              timestamp: new Date(),
              payload: { method: msg.type, message: msg.content?.slice(0, 200) },
            });
          }
          if (msg.type === "result" && msg.usage) {
            onEvent({
              event: "notification",
              timestamp: new Date(),
              usage: {
                input_tokens: msg.usage.input_tokens ?? 0,
                output_tokens: msg.usage.output_tokens ?? 0,
                total_tokens: (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0),
              },
              payload: { method: "thread/tokenUsage/updated", params: { totalTokenUsage: msg.usage } },
            });
          }
        } catch {
          // streaming text output
        }
        output += line + "\n";
      });

      child.stderr?.on("data", (data: Buffer) => {
        logger.debug("claude_code_stderr", { data: data.toString().slice(0, 500) });
      });

      child.on("close", (code) => {
        this.process = null;
        if (code === 0) {
          onEvent({ event: "turn_completed", timestamp: new Date(), payload: {} });
          resolve({ session_id: sessionId, thread_id: threadId, turn_id: turnId, result: "turn_completed" });
        } else {
          onEvent({ event: "turn_failed", timestamp: new Date(), payload: { exit_code: code } });
          reject(new Error(`Claude Code exited with code ${code}`));
        }
      });

      child.on("error", (err) => {
        this.process = null;
        reject(new Error(`Claude Code spawn failed: ${err.message}`));
      });

      child.stdin?.write(prompt);
      child.stdin?.end();
    });
  }

  stop(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      setTimeout(() => {
        try { this.process?.kill("SIGKILL"); } catch {}
      }, 5000);
      this.process = null;
    }
  }

  private buildArgs(prompt: string, issue: Issue): string[] {
    const args: string[] = ["--print", "--output-format", "stream-json"];

    if (this.config.model) {
      args.push("--model", this.config.model);
    }

    if (this.config.max_turns) {
      args.push("--max-turns", String(this.config.max_turns));
    }

    for (const tool of this.config.allowed_tools) {
      args.push("--allowedTools", tool);
    }

    args.push("--prompt", prompt);

    return args;
  }
}

function getClaudeCodeConfig(config: ServiceConfig): ClaudeCodeSessionConfig {
  return {
    command: config.claude_code.command,
    model: config.claude_code.model,
    max_turns: config.claude_code.max_turns,
    allowed_tools: config.claude_code.allowed_tools,
  };
}
