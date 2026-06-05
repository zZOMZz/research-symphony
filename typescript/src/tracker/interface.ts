import { Issue } from "../types.js";

export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;

  fetchIssueStatesByIds(ids: string[]): Promise<Issue[]>;

  fetchIssuesByStates(stateNames: string[]): Promise<Array<{ id: string; identifier: string; state: string }>>;

  executeGraphql?(query: string, variables?: Record<string, unknown>): Promise<{ success: boolean; data: unknown }>;
}
