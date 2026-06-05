# Symphony TypeScript

This directory contains the TypeScript implementation of the Symphony agent orchestration service that polls Linear, creates per-issue workspaces, and runs Codex in app-server mode.

## Environment

- Node.js: `>=20.x`
- Install deps: `npm install`
- Build: `npm run build`
- Dev mode: `npm run dev -- path/to/WORKFLOW.md`

## Usage

```bash
# Build
npm run build

# Run with explicit workflow path
node dist/cli.js path/to/WORKFLOW.md

# Run with --port for HTTP dashboard
node dist/cli.js path/to/WORKFLOW.md --port 4000

# Dev mode (no build step)
npx tsx src/cli.ts path/to/WORKFLOW.md
```

## Architecture

- `src/types.ts` — Domain model types (Issue, ServiceConfig, RunningEntry, etc.)
- `src/workflow.ts` — WORKFLOW.md loader with YAML front matter parsing and file watching
- `src/config.ts` — Typed config layer with defaults, $VAR resolution, validation
- `src/linear/client.ts` — Linear GraphQL client with pagination, normalization
- `src/workspace.ts` — Workspace manager with path safety, hooks
- `src/prompt.ts` — Liquid-compatible template rendering with strict mode
- `src/codex/app_server.ts` — Codex app-server JSON line protocol client
- `src/agent_runner.ts` — Agent runner (workspace + prompt + multi-turn agent)
- `src/orchestrator.ts` — Orchestrator (poll, dispatch, reconcile, retry)
- `src/http_server.ts` — Optional HTTP server with dashboard and JSON API
- `src/cli.ts` — CLI entry point

## Codebase Conventions

- Keep the implementation aligned with [`../SPEC.md`](../SPEC.md).
- Runtime config is loaded from `WORKFLOW.md` front matter via `workflow.ts` and `config.ts`.
- Workspace safety is critical:
  - Never run Codex with cwd in source repo.
  - Workspaces must stay under configured workspace root.
- Orchestrator is stateful; preserve retry, reconciliation, and cleanup semantics.

## Trust and Safety Posture

This implementation targets trusted environments with:
- Auto-approval of command execution and file changes
- User input requests treated as hard failure
- Workspace isolation via path validation
