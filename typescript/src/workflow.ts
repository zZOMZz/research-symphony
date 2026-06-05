import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { WorkflowDefinition } from "./types.js";
import { logger } from "./logger.js";

const WORKFLOW_FILE_NAME = "WORKFLOW.md";

let workflowFilePath: string | null = null;
let cachedWorkflow: WorkflowDefinition | null = null;
let watcher: fs.FSWatcher | null = null;
let onReloadCallback: (() => void) | null = null;

export function setWorkflowFilePath(p: string): void {
  workflowFilePath = p;
  cachedWorkflow = null;
}

export function getWorkflowFilePath(): string {
  return workflowFilePath ?? path.join(process.cwd(), WORKFLOW_FILE_NAME);
}

export function loadWorkflow(filePath?: string): WorkflowDefinition {
  const target = filePath ?? getWorkflowFilePath();
  let content: string;
  try {
    content = fs.readFileSync(target, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new WorkflowError("missing_workflow_file", `Cannot read workflow file: ${target} (${code})`);
  }
  return parseWorkflowContent(content);
}

export function currentWorkflow(): WorkflowDefinition {
  if (cachedWorkflow) return cachedWorkflow;
  cachedWorkflow = loadWorkflow();
  return cachedWorkflow;
}

export function reloadWorkflow(): WorkflowDefinition | null {
  try {
    cachedWorkflow = loadWorkflow();
    return cachedWorkflow;
  } catch (err) {
    logger.error("workflow_reload_failed", { error: String(err) });
    return null;
  }
}

export function startWatching(onChange?: () => void): void {
  onReloadCallback = onChange ?? null;
  const filePath = getWorkflowFilePath();
  if (watcher) {
    watcher.close();
  }
  try {
    watcher = fs.watch(filePath, { persistent: false }, (_eventType) => {
      const reloaded = reloadWorkflow();
      if (reloaded && onReloadCallback) {
        onReloadCallback();
      }
    });
  } catch {
    logger.warn("workflow_watch_failed", { path: filePath });
  }
}

export function stopWatching(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

function parseWorkflowContent(content: string): WorkflowDefinition {
  const lines = content.split(/\r?\n/);
  let config: Record<string, unknown> = {};
  let promptLines: string[];

  if (lines[0] === "---") {
    const endIdx = lines.indexOf("---", 1);
    if (endIdx === -1) {
      throw new WorkflowError("workflow_parse_error", "Unclosed YAML front matter");
    }
    const yamlContent = lines.slice(1, endIdx).join("\n");
    if (yamlContent.trim() === "") {
      config = {};
    } else {
      let parsed: unknown;
      try {
        parsed = parseYaml(yamlContent);
      } catch (err) {
        throw new WorkflowError("workflow_parse_error", `Invalid YAML: ${err}`);
      }
      if (parsed === null || parsed === undefined) {
        config = {};
      } else if (typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new WorkflowError("workflow_front_matter_not_a_map", "Front matter must be a map/object");
      } else {
        config = parsed as Record<string, unknown>;
      }
    }
    promptLines = lines.slice(endIdx + 1);
  } else {
    promptLines = lines;
  }

  const prompt_template = promptLines.join("\n").trim();
  return { config, prompt_template };
}

export class WorkflowError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}
