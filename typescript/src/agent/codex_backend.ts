import { Issue, ServiceConfig, CodexEvent } from "../types.js";
import { AgentBackend, AgentSession, TurnResult } from "./interface.js";
import * as appServer from "../codex/app_server.js";

export class CodexBackend implements AgentBackend {
  async startSession(workspace: string, config: ServiceConfig): Promise<AgentSession> {
    const session = await appServer.startSession(workspace, config);
    return new CodexSession(session);
  }
}

class CodexSession implements AgentSession {
  constructor(private session: appServer.AppServerSession) {}

  async runTurn(prompt: string, issue: Issue, onEvent: (event: CodexEvent) => void): Promise<TurnResult> {
    const result = await appServer.runTurn(this.session, prompt, issue, onEvent);
    return result;
  }

  stop(): void {
    appServer.stopSession(this.session);
  }
}
