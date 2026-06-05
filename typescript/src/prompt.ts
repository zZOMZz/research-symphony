import { Liquid } from "liquidjs";
import { Issue } from "./types.js";
import { getWorkflowPrompt } from "./config.js";

const engine = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

export function buildPrompt(issue: Issue, opts?: { attempt?: number | null }): string {
  const template = getWorkflowPrompt();
  return renderTemplate(template, issue, opts?.attempt ?? null);
}

export function renderTemplate(template: string, issue: Issue, attempt: number | null): string {
  const issueCtx = issueToTemplateContext(issue);
  const context = { issue: issueCtx, attempt };

  try {
    return engine.parseAndRenderSync(template, context);
  } catch (err) {
    throw new PromptError("template_render_error", `Template render failed: ${err}`);
  }
}

function issueToTemplateContext(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    branch_name: issue.branch_name,
    url: issue.url,
    labels: issue.labels,
    blocked_by: issue.blocked_by.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
    })),
    created_at: issue.created_at?.toISOString() ?? null,
    updated_at: issue.updated_at?.toISOString() ?? null,
  };
}

export class PromptError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "PromptError";
  }
}
