import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { ServiceConfig } from "./types.js";
import { logger } from "./logger.js";

export function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function workspacePath(config: ServiceConfig, identifier: string): string {
  const safe = sanitizeIdentifier(identifier);
  return path.join(config.workspace.root, safe);
}

export function validateWorkspacePath(workspacePath: string, workspaceRoot: string): void {
  const absWorkspace = path.resolve(workspacePath);
  const absRoot = path.resolve(workspaceRoot);

  if (absWorkspace === absRoot) {
    throw new WorkspaceError("workspace_equals_root", `Workspace path equals root: ${absWorkspace}`);
  }

  if (!absWorkspace.startsWith(absRoot + path.sep)) {
    throw new WorkspaceError("workspace_outside_root", `Workspace ${absWorkspace} is outside root ${absRoot}`);
  }
}

export interface WorkspaceResult {
  path: string;
  created_now: boolean;
}

export async function createForIssue(config: ServiceConfig, identifier: string): Promise<WorkspaceResult> {
  const wsPath = workspacePath(config, identifier);
  validateWorkspacePath(wsPath, config.workspace.root);

  await fs.promises.mkdir(config.workspace.root, { recursive: true });

  let createdNow = false;
  try {
    const stat = await fs.promises.stat(wsPath);
    if (!stat.isDirectory()) {
      await fs.promises.rm(wsPath, { recursive: true, force: true });
      await fs.promises.mkdir(wsPath, { recursive: true });
      createdNow = true;
    }
  } catch {
    await fs.promises.mkdir(wsPath, { recursive: true });
    createdNow = true;
  }

  if (createdNow && config.hooks.after_create) {
    const result = await runHook(config.hooks.after_create, wsPath, config.hooks.timeout_ms);
    if (!result.success) {
      await fs.promises.rm(wsPath, { recursive: true, force: true }).catch(() => {});
      throw new WorkspaceError("after_create_hook_failed", `after_create hook failed: ${result.error}`);
    }
  }

  return { path: wsPath, created_now: createdNow };
}

export async function removeWorkspace(config: ServiceConfig, identifier: string): Promise<void> {
  const wsPath = workspacePath(config, identifier);
  try {
    validateWorkspacePath(wsPath, config.workspace.root);
  } catch {
    return;
  }

  const exists = await fs.promises.stat(wsPath).then(() => true).catch(() => false);
  if (!exists) return;

  if (config.hooks.before_remove) {
    await runHook(config.hooks.before_remove, wsPath, config.hooks.timeout_ms).catch((err) => {
      logger.warn("before_remove_hook_error", { workspace: wsPath, error: String(err) });
    });
  }

  await fs.promises.rm(wsPath, { recursive: true, force: true });
}

export async function runBeforeRunHook(config: ServiceConfig, wsPath: string): Promise<void> {
  if (!config.hooks.before_run) return;
  const result = await runHook(config.hooks.before_run, wsPath, config.hooks.timeout_ms);
  if (!result.success) {
    throw new WorkspaceError("before_run_hook_failed", `before_run hook failed: ${result.error}`);
  }
}

export async function runAfterRunHook(config: ServiceConfig, wsPath: string): Promise<void> {
  if (!config.hooks.after_run) return;
  await runHook(config.hooks.after_run, wsPath, config.hooks.timeout_ms).catch((err) => {
    logger.warn("after_run_hook_error", { workspace: wsPath, error: String(err) });
  });
}

interface HookResult {
  success: boolean;
  error?: string;
  output?: string;
}

function runHook(script: string, cwd: string, timeoutMs: number): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", script], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let output = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      if (output.length < 2048) output += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (output.length < 2048) output += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ success: false, error: `Hook timed out after ${timeoutMs}ms`, output });
      } else if (code === 0) {
        resolve({ success: true, output });
      } else {
        resolve({ success: false, error: `Hook exited with code ${code}`, output });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: `Hook spawn error: ${err.message}` });
    });
  });
}

export class WorkspaceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
