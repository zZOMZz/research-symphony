import { Issue, BlockerRef } from "../types.js";
import { logger } from "../logger.js";

export interface LinearClientConfig {
  endpoint: string;
  api_key: string;
  project_slug: string;
  active_states: string[];
  terminal_states: string[];
}

const ISSUE_PAGE_SIZE = 50;
const NETWORK_TIMEOUT_MS = 30000;

const CANDIDATE_QUERY = `
query SymphonyLinearPoll($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $relationFirst: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue { id identifier state { name } }
        }
      }
      createdAt
      updatedAt
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

const ISSUES_BY_IDS_QUERY = `
query SymphonyLinearIssuesById($ids: [ID!]!, $first: Int!, $relationFirst: Int!) {
  issues(filter: {id: {in: $ids}}, first: $first) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      labels { nodes { name } }
      inverseRelations(first: $relationFirst) {
        nodes {
          type
          issue { id identifier state { name } }
        }
      }
      createdAt
      updatedAt
    }
  }
}`;

const ISSUES_BY_STATES_QUERY = `
query SymphonyLinearIssuesByStates($projectSlug: String!, $stateNames: [String!]!, $first: Int!, $after: String) {
  issues(filter: {project: {slugId: {eq: $projectSlug}}, state: {name: {in: $stateNames}}}, first: $first, after: $after) {
    nodes {
      id
      identifier
      state { name }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

export class LinearClient {
  private config: LinearClientConfig;

  constructor(config: LinearClientConfig) {
    this.config = config;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    const issues: Issue[] = [];
    let after: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const variables: Record<string, unknown> = {
        projectSlug: this.config.project_slug,
        stateNames: this.config.active_states,
        first: ISSUE_PAGE_SIZE,
        relationFirst: 50,
        after,
      };

      const data = await this.graphqlRequest(CANDIDATE_QUERY, variables);
      const issuesPayload = data?.issues;
      if (!issuesPayload?.nodes) {
        throw new LinearApiError("linear_unknown_payload", "Missing issues.nodes in response");
      }

      for (const node of issuesPayload.nodes) {
        issues.push(normalizeIssue(node));
      }

      const pageInfo = issuesPayload.pageInfo;
      hasNextPage = pageInfo?.hasNextPage === true;
      if (hasNextPage) {
        if (!pageInfo?.endCursor) {
          throw new LinearApiError("linear_missing_end_cursor", "Pagination integrity: hasNextPage but no endCursor");
        }
        after = pageInfo.endCursor;
      }
    }

    return issues;
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];

    const variables = {
      ids,
      first: ids.length,
      relationFirst: 50,
    };

    const data = await this.graphqlRequest(ISSUES_BY_IDS_QUERY, variables);
    const issuesPayload = data?.issues;
    if (!issuesPayload?.nodes) {
      throw new LinearApiError("linear_unknown_payload", "Missing issues.nodes in response");
    }

    return (issuesPayload.nodes as any[]).map(normalizeIssue);
  }

  async fetchIssuesByStates(stateNames: string[]): Promise<Array<{ id: string; identifier: string; state: string }>> {
    if (stateNames.length === 0) return [];

    const results: Array<{ id: string; identifier: string; state: string }> = [];
    let after: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const variables: Record<string, unknown> = {
        projectSlug: this.config.project_slug,
        stateNames,
        first: ISSUE_PAGE_SIZE,
        after,
      };

      const data = await this.graphqlRequest(ISSUES_BY_STATES_QUERY, variables);
      const issuesPayload = data?.issues;
      if (!issuesPayload?.nodes) {
        throw new LinearApiError("linear_unknown_payload", "Missing issues.nodes in response");
      }

      for (const node of issuesPayload.nodes as any[]) {
        results.push({
          id: node.id,
          identifier: node.identifier,
          state: node.state?.name ?? "",
        });
      }

      const pageInfo = issuesPayload.pageInfo;
      hasNextPage = pageInfo?.hasNextPage === true;
      if (hasNextPage) {
        if (!pageInfo?.endCursor) {
          throw new LinearApiError("linear_missing_end_cursor", "Pagination integrity error");
        }
        after = pageInfo.endCursor;
      }
    }

    return results;
  }

  async executeGraphql(query: string, variables?: Record<string, unknown>): Promise<{ success: boolean; data: unknown }> {
    try {
      const data = await this.graphqlRequest(query, variables ?? {});
      return { success: true, data };
    } catch (err) {
      return { success: false, data: { error: String(err) } };
    }
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private async graphqlRequest(query: string, variables: Record<string, unknown>): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.config.api_key,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LinearApiError(
          "linear_api_status",
          `Linear API returned ${response.status}: ${body.slice(0, 1000)}`,
        );
      }

      const json = (await response.json()) as any;

      if (json.errors && Array.isArray(json.errors) && json.errors.length > 0) {
        throw new LinearApiError(
          "linear_graphql_errors",
          `GraphQL errors: ${JSON.stringify(json.errors).slice(0, 1000)}`,
        );
      }

      return json.data ?? {};
    } catch (err) {
      if (err instanceof LinearApiError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new LinearApiError("linear_api_request", "Linear API request timed out");
      }
      throw new LinearApiError("linear_api_request", `Linear API request failed: ${err}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function normalizeIssue(node: any): Issue {
  const blockedBy: BlockerRef[] = [];
  if (node.inverseRelations?.nodes) {
    for (const rel of node.inverseRelations.nodes) {
      if (rel.type === "blocks" && rel.issue) {
        blockedBy.push({
          id: rel.issue.id ?? null,
          identifier: rel.issue.identifier ?? null,
          state: rel.issue.state?.name ?? null,
        });
      }
    }
  }

  const labels: string[] = [];
  if (node.labels?.nodes) {
    for (const label of node.labels.nodes) {
      if (label.name) labels.push(label.name.toLowerCase());
    }
  }

  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description ?? null,
    priority: typeof node.priority === "number" ? node.priority : null,
    state: node.state?.name ?? "",
    branch_name: node.branchName ?? null,
    url: node.url ?? null,
    labels,
    blocked_by: blockedBy,
    created_at: node.createdAt ? new Date(node.createdAt) : null,
    updated_at: node.updatedAt ? new Date(node.updatedAt) : null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class LinearApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "LinearApiError";
  }
}
