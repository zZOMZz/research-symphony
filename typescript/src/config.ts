import * as path from "node:path";
import * as os from "node:os";
import {
  ServiceConfig,
  TrackerConfig,
  PollingConfig,
  WorkspaceConfig,
  HooksConfig,
  AgentConfig,
  CodexConfig,
  ServerConfig,
} from "./types.js";
import { currentWorkflow, getWorkflowFilePath } from "./workflow.js";

const DEFAULTS: ServiceConfig = {
  tracker: {
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    api_key: null,
    project_slug: null,
    active_states: ["Todo", "In Progress"],
    terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
  },
  polling: {
    interval_ms: 30000,
  },
  workspace: {
    root: path.join(os.tmpdir(), "symphony_workspaces"),
  },
  hooks: {
    after_create: null,
    before_run: null,
    after_run: null,
    before_remove: null,
    timeout_ms: 60000,
  },
  agent: {
    max_concurrent_agents: 10,
    max_turns: 20,
    max_retry_backoff_ms: 300000,
    max_concurrent_agents_by_state: {},
  },
  codex: {
    command: "codex app-server",
    approval_policy: {
      reject: {
        sandbox_approval: true,
        rules: true,
        mcp_elicitations: true,
      },
    },
    thread_sandbox: "workspace-write",
    turn_sandbox_policy: null,
    turn_timeout_ms: 3600000,
    read_timeout_ms: 5000,
    stall_timeout_ms: 300000,
  },
  server: {
    port: null,
    host: "127.0.0.1",
  },
};

const DEFAULT_PROMPT_TEMPLATE = `You are working on a Linear issue.

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}

Body:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}
`;

export function getSettings(): ServiceConfig {
  const workflow = currentWorkflow();
  return parseConfig(workflow.config);
}

export function getWorkflowPrompt(): string {
  const workflow = currentWorkflow();
  if (workflow.prompt_template.trim() === "") {
    return DEFAULT_PROMPT_TEMPLATE;
  }
  return workflow.prompt_template;
}

export function parseConfig(raw: Record<string, unknown>): ServiceConfig {
  const normalized = normalizeKeys(raw) as Record<string, unknown>;
  return {
    tracker: parseTracker(normalized.tracker as Record<string, unknown> | undefined),
    polling: parsePolling(normalized.polling as Record<string, unknown> | undefined),
    workspace: parseWorkspace(normalized.workspace as Record<string, unknown> | undefined),
    hooks: parseHooks(normalized.hooks as Record<string, unknown> | undefined),
    agent: parseAgent(normalized.agent as Record<string, unknown> | undefined),
    codex: parseCodex(normalized.codex as Record<string, unknown> | undefined),
    server: parseServer(normalized.server as Record<string, unknown> | undefined),
  };
}

function parseTracker(raw?: Record<string, unknown>): TrackerConfig {
  if (!raw) return { ...DEFAULTS.tracker };
  return {
    kind: asString(raw.kind, DEFAULTS.tracker.kind),
    endpoint: asString(raw.endpoint, DEFAULTS.tracker.endpoint),
    api_key: resolveSecret(raw.api_key as string | undefined, "LINEAR_API_KEY"),
    project_slug: asStringOrNull(raw.project_slug),
    active_states: asStringArray(raw.active_states, DEFAULTS.tracker.active_states),
    terminal_states: asStringArray(raw.terminal_states, DEFAULTS.tracker.terminal_states),
  };
}

function parsePolling(raw?: Record<string, unknown>): PollingConfig {
  if (!raw) return { ...DEFAULTS.polling };
  const interval_ms = asPositiveInt(raw.interval_ms, DEFAULTS.polling.interval_ms);
  return { interval_ms };
}

function parseWorkspace(raw?: Record<string, unknown>): WorkspaceConfig {
  if (!raw) return { ...DEFAULTS.workspace };
  const rootValue = raw.root as string | undefined;
  return { root: resolvePath(rootValue, DEFAULTS.workspace.root) };
}

function parseHooks(raw?: Record<string, unknown>): HooksConfig {
  if (!raw) return { ...DEFAULTS.hooks };
  return {
    after_create: asStringOrNull(raw.after_create),
    before_run: asStringOrNull(raw.before_run),
    after_run: asStringOrNull(raw.after_run),
    before_remove: asStringOrNull(raw.before_remove),
    timeout_ms: asPositiveInt(raw.timeout_ms, DEFAULTS.hooks.timeout_ms),
  };
}

function parseAgent(raw?: Record<string, unknown>): AgentConfig {
  if (!raw) return { ...DEFAULTS.agent };
  const byState = raw.max_concurrent_agents_by_state as Record<string, unknown> | undefined;
  return {
    max_concurrent_agents: asPositiveInt(raw.max_concurrent_agents, DEFAULTS.agent.max_concurrent_agents),
    max_turns: asPositiveInt(raw.max_turns, DEFAULTS.agent.max_turns),
    max_retry_backoff_ms: asPositiveInt(raw.max_retry_backoff_ms, DEFAULTS.agent.max_retry_backoff_ms),
    max_concurrent_agents_by_state: normalizeStateLimits(byState),
  };
}

function parseCodex(raw?: Record<string, unknown>): CodexConfig {
  if (!raw) return { ...DEFAULTS.codex };
  return {
    command: asString(raw.command, DEFAULTS.codex.command),
    approval_policy: raw.approval_policy != null ? (raw.approval_policy as string | Record<string, unknown>) : DEFAULTS.codex.approval_policy,
    thread_sandbox: asString(raw.thread_sandbox, DEFAULTS.codex.thread_sandbox),
    turn_sandbox_policy: (raw.turn_sandbox_policy as Record<string, unknown>) ?? null,
    turn_timeout_ms: asPositiveInt(raw.turn_timeout_ms, DEFAULTS.codex.turn_timeout_ms),
    read_timeout_ms: asPositiveInt(raw.read_timeout_ms, DEFAULTS.codex.read_timeout_ms),
    stall_timeout_ms: asNonNegativeInt(raw.stall_timeout_ms, DEFAULTS.codex.stall_timeout_ms),
  };
}

function parseServer(raw?: Record<string, unknown>): ServerConfig {
  if (!raw) return { ...DEFAULTS.server };
  return {
    port: raw.port != null ? asNonNegativeInt(raw.port, null) : null,
    host: asString(raw.host, DEFAULTS.server.host),
  };
}

export function validateDispatchConfig(config: ServiceConfig): string | null {
  if (!config.tracker.kind) return "tracker.kind is required";
  if (config.tracker.kind !== "linear") return `unsupported tracker kind: ${config.tracker.kind}`;
  if (!config.tracker.api_key) return "tracker.api_key is missing (set LINEAR_API_KEY or configure in WORKFLOW.md)";
  if (!config.tracker.project_slug) return "tracker.project_slug is required";
  if (!config.codex.command) return "codex.command is required";
  return null;
}

export function maxConcurrentAgentsForState(config: ServiceConfig, stateName: string): number {
  const normalized = stateName.toLowerCase();
  return config.agent.max_concurrent_agents_by_state[normalized] ?? config.agent.max_concurrent_agents;
}

export function resolveDefaultTurnSandboxPolicy(config: ServiceConfig, workspace?: string): Record<string, unknown> {
  if (config.codex.turn_sandbox_policy) return config.codex.turn_sandbox_policy;
  const root = workspace ?? config.workspace.root;
  const expandedRoot = path.resolve(root);
  return {
    type: "workspaceWrite",
    writableRoots: [expandedRoot],
    readOnlyAccess: { type: "fullAccess" },
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function normalizeStateLimits(raw?: Record<string, unknown>): Record<string, number> {
  if (!raw) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "") continue;
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) continue;
    result[normalizedKey] = num;
  }
  return result;
}

function resolveSecret(value: string | undefined | null, envName: string): string | null {
  if (value == null) {
    const env = process.env[envName];
    return env && env !== "" ? env : null;
  }
  const resolved = resolveEnvValue(value, envName);
  return resolved && resolved !== "" ? resolved : null;
}

function resolveEnvValue(value: string, fallbackEnvName: string): string | null {
  const envRef = parseEnvReference(value);
  if (envRef) {
    const envVal = process.env[envRef];
    if (envVal === undefined) {
      const fallback = process.env[fallbackEnvName];
      return fallback ?? null;
    }
    return envVal === "" ? null : envVal;
  }
  return value;
}

function resolvePath(value: string | undefined | null, defaultPath: string): string {
  if (!value) return defaultPath;
  const envRef = parseEnvReference(value);
  if (envRef) {
    const envVal = process.env[envRef];
    if (!envVal) return defaultPath;
    return expandPath(envVal);
  }
  return expandPath(value);
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  if (p === "~") {
    return os.homedir();
  }
  if (path.isAbsolute(p)) return p;
  const workflowDir = path.dirname(getWorkflowFilePath());
  return path.resolve(workflowDir, p);
}

function parseEnvReference(value: string): string | null {
  if (!value.startsWith("$")) return null;
  const envName = value.slice(1);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) return envName;
  return null;
}

function normalizeKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(normalizeKeys);
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[normalizeKey(key)] = normalizeKeys(value);
    }
    return result;
  }
  return obj;
}

function normalizeKey(key: string): string {
  return key.replace(/-/g, "_");
}

function asString(val: unknown, def: string): string {
  if (typeof val === "string" && val !== "") return val;
  return def;
}

function asStringOrNull(val: unknown): string | null {
  if (typeof val === "string" && val !== "") return val;
  return null;
}

function asStringArray(val: unknown, def: string[]): string[] {
  if (Array.isArray(val)) return val.filter((v) => typeof v === "string") as string[];
  return def;
}

function asPositiveInt(val: unknown, def: number): number {
  const num = Number(val);
  if (Number.isInteger(num) && num > 0) return num;
  return def;
}

function asNonNegativeInt(val: unknown, def: number | null): number {
  const num = Number(val);
  if (Number.isInteger(num) && num >= 0) return num;
  return def ?? 0;
}
