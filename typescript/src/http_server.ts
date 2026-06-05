import * as http from "node:http";
import { Orchestrator } from "./orchestrator.js";
import { logger } from "./logger.js";

export function createHttpServer(orchestrator: Orchestrator, host: string, port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/") {
      serveDashboard(orchestrator, res);
    } else if (req.method === "GET" && pathname === "/api/v1/state") {
      serveState(orchestrator, res);
    } else if (req.method === "POST" && pathname === "/api/v1/refresh") {
      serveRefresh(orchestrator, res);
    } else if (req.method === "GET" && pathname.startsWith("/api/v1/")) {
      const identifier = decodeURIComponent(pathname.slice("/api/v1/".length));
      serveIssueDetail(orchestrator, identifier, res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "Not found" } }));
    }
  });

  server.listen(port, host, () => {
    logger.info("http_server_started", { host, port });
  });

  return server;
}

function serveDashboard(orchestrator: Orchestrator, res: http.ServerResponse): void {
  const snapshot = orchestrator.getSnapshot();
  const html = renderDashboardHtml(snapshot);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function serveState(orchestrator: Orchestrator, res: http.ServerResponse): void {
  const snapshot = orchestrator.getSnapshot();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(snapshot));
}

function serveRefresh(orchestrator: Orchestrator, res: http.ServerResponse): void {
  orchestrator.requestRefresh();
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    queued: true,
    coalesced: false,
    requested_at: new Date().toISOString(),
    operations: ["poll", "reconcile"],
  }));
}

function serveIssueDetail(orchestrator: Orchestrator, identifier: string, res: http.ServerResponse): void {
  const detail = orchestrator.getIssueDetail(identifier);
  if (!detail) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "issue_not_found", message: `Issue ${identifier} not found in current state` } }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(detail));
}

function renderDashboardHtml(snapshot: ReturnType<Orchestrator["getSnapshot"]>): string {
  const runningRows = snapshot.running.map((r) =>
    `<tr>
      <td>${esc(r.issue_identifier)}</td>
      <td>${esc(r.state)}</td>
      <td>${r.turn_count}</td>
      <td>${esc(r.last_event ?? "-")}</td>
      <td>${esc(r.last_message ?? "-")}</td>
      <td>${r.tokens.total_tokens}</td>
      <td>${esc(r.started_at)}</td>
    </tr>`,
  ).join("\n");

  const retryRows = snapshot.retrying.map((r) =>
    `<tr>
      <td>${esc(r.issue_identifier)}</td>
      <td>${r.attempt}</td>
      <td>${esc(r.due_at)}</td>
      <td>${esc(r.error ?? "-")}</td>
    </tr>`,
  ).join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <title>Symphony Dashboard</title>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="5">
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #f8f9fa; }
    h1 { color: #333; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; font-size: 0.85rem; }
    th { background: #e9ecef; }
    .stats { display: flex; gap: 2rem; margin: 1rem 0; }
    .stat { background: white; padding: 1rem; border-radius: 4px; border: 1px solid #ddd; }
    .stat-label { font-size: 0.75rem; color: #666; text-transform: uppercase; }
    .stat-value { font-size: 1.5rem; font-weight: bold; }
  </style>
</head>
<body>
  <h1>Symphony</h1>
  <p>Generated: ${esc(snapshot.generated_at)}</p>
  <div class="stats">
    <div class="stat"><div class="stat-label">Running</div><div class="stat-value">${snapshot.counts.running}</div></div>
    <div class="stat"><div class="stat-label">Retrying</div><div class="stat-value">${snapshot.counts.retrying}</div></div>
    <div class="stat"><div class="stat-label">Total Tokens</div><div class="stat-value">${snapshot.codex_totals.total_tokens}</div></div>
    <div class="stat"><div class="stat-label">Runtime</div><div class="stat-value">${Math.round(snapshot.codex_totals.seconds_running)}s</div></div>
  </div>

  <h2>Running Sessions</h2>
  <table>
    <thead><tr><th>Issue</th><th>State</th><th>Turns</th><th>Last Event</th><th>Message</th><th>Tokens</th><th>Started</th></tr></thead>
    <tbody>${runningRows || "<tr><td colspan=\"7\">No active sessions</td></tr>"}</tbody>
  </table>

  <h2>Retry Queue</h2>
  <table>
    <thead><tr><th>Issue</th><th>Attempt</th><th>Due At</th><th>Error</th></tr></thead>
    <tbody>${retryRows || "<tr><td colspan=\"4\">No retries queued</td></tr>"}</tbody>
  </table>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
