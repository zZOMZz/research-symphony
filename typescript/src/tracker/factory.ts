import { ServiceConfig } from "../types.js";
import { TrackerClient } from "./interface.js";
import { LinearClient } from "./linear_client.js";

export function createTrackerClient(config: ServiceConfig): TrackerClient {
  switch (config.tracker.kind) {
    case "linear":
      if (!config.tracker.api_key) {
        throw new Error("tracker.api_key is required for Linear tracker");
      }
      if (!config.tracker.project_slug) {
        throw new Error("tracker.project_slug is required for Linear tracker");
      }
      return new LinearClient({
        endpoint: config.tracker.endpoint,
        api_key: config.tracker.api_key,
        project_slug: config.tracker.project_slug,
        active_states: config.tracker.active_states,
        terminal_states: config.tracker.terminal_states,
      });

    default:
      throw new Error(`Unsupported tracker kind: ${config.tracker.kind}`);
  }
}

export type { TrackerClient } from "./interface.js";
