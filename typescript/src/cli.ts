import * as path from "node:path";
import { setWorkflowFilePath, loadWorkflow, startWatching } from "./workflow.js";
import { getSettings, validateDispatchConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { createHttpServer } from "./http_server.js";
import { logger } from "./logger.js";

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let workflowPath: string | null = null;
  let portOverride: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) {
      portOverride = parseInt(args[i + 1], 10);
      i++;
    } else if (!args[i].startsWith("-")) {
      workflowPath = args[i];
    }
  }

  if (workflowPath) {
    const resolved = path.resolve(workflowPath);
    setWorkflowFilePath(resolved);
  } else {
    const defaultPath = path.resolve("WORKFLOW.md");
    setWorkflowFilePath(defaultPath);
  }

  try {
    loadWorkflow();
  } catch (err) {
    logger.error("startup_failed", { error: String(err) });
    process.exit(1);
  }

  const config = getSettings();
  const validationError = validateDispatchConfig(config);
  if (validationError) {
    logger.error("startup_validation_failed", { error: validationError });
    process.exit(1);
  }

  const orchestrator = new Orchestrator();

  startWatching(() => {
    logger.info("workflow_reloaded");
  });

  const port = portOverride ?? config.server.port;
  if (port != null) {
    createHttpServer(orchestrator, config.server.host, port);
  }

  await orchestrator.start();

  logger.info("symphony_started", {
    tracker: config.tracker.kind,
    project: config.tracker.project_slug,
    poll_interval_ms: config.polling.interval_ms,
    max_concurrent: config.agent.max_concurrent_agents,
  });

  const shutdown = (): void => {
    logger.info("symphony_shutting_down");
    orchestrator.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error("unhandled_error", { error: String(err) });
  process.exit(1);
});
