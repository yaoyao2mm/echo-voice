import { config } from "./config.js";
import { loadDesktopAgentId } from "./lib/agentIdentity.js";
import { CodexInteractiveRuntime } from "./lib/codexInteractiveRunner.js";
import { publicCodexRuntime, publicWorkspaces, runCodexJob } from "./lib/codexRunner.js";
import { describeHttpNetwork, formatFetchError, httpFetch } from "./lib/http.js";

if (!config.relayUrl) {
  console.error("Missing ECHO_RELAY_URL. Example: ECHO_RELAY_URL=https://voice.example.com ECHO_TOKEN=... pnpm run desktop");
  process.exit(1);
}

if (!config.token) {
  console.error("Missing ECHO_TOKEN. Use the same token as the relay server.");
  process.exit(1);
}

const agentId = await loadDesktopAgentId();

console.log("Echo Codex desktop agent is running.");
console.log(`Relay: ${config.relayUrl}`);
console.log(`Agent ID: ${agentId}`);
console.log(`Network: ${formatNetworkStatus(describeHttpNetwork(config.relayUrl))}`);
console.log(`Codex remote: ${config.codex.enabled ? "enabled" : "disabled"}`);
if (config.codex.enabled) {
  const runtime = publicCodexRuntime();
  console.log(`  command: ${runtime.command}`);
  console.log(`  model: ${runtime.model || "Codex default"}`);
  console.log(`  sandbox: ${runtime.sandbox}`);
  for (const workspace of publicWorkspaces()) {
    console.log(`  ${workspace.id}: ${workspace.path}`);
  }
}
console.log("Waiting for mobile Codex tasks.\n");

if (config.codex.enabled) {
  runCodexLoop();
  runCodexSessionLoop();
}

async function runCodexLoop() {
  while (true) {
    let job = null;
    try {
      job = await pollNextCodexJob();
      if (!job) continue;

      console.log(`[${new Date().toLocaleTimeString()}] codex ${job.id} in ${job.projectId}`);
      const heartbeat = startCodexLeaseHeartbeat(job.id);
      const result = await runCodexJob(job, {
        onEvents: (events) => postJson("/api/agent/codex/events", { id: job.id, agentId, events }).catch(() => {})
      }).finally(() => clearInterval(heartbeat));
      await postJson("/api/agent/codex/complete", { id: job.id, agentId, result });
      console.log(`  codex ${result.ok ? "completed" : "failed"} (${result.exitCode ?? "no exit code"})`);
    } catch (error) {
      console.error(`[codex ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}`);
      if (job?.id) {
        await postJson("/api/agent/codex/complete", {
          id: job.id,
          agentId,
          result: {
            ok: false,
            error: error.message
          }
        }).catch(() => {});
      }
      await sleep(2500);
    }
  }
}

async function runCodexSessionLoop() {
  const runtime = new CodexInteractiveRuntime({
    agentId,
    onEvents: (id, events) => postJson("/api/agent/codex/sessions/events", { id, agentId, events }).catch(() => {})
  });

  while (true) {
    let command = null;
    try {
      command = await pollNextCodexSessionCommand();
      if (!command) continue;

      console.log(`[${new Date().toLocaleTimeString()}] codex session ${command.sessionId} ${command.type}`);
      const heartbeat = startCodexSessionHeartbeat(command.sessionId);
      const result = await runtime.handleCommand(command).finally(() => clearInterval(heartbeat));
      await postJson("/api/agent/codex/sessions/commands/complete", { id: command.id, agentId, result });
      console.log(`  session ${command.type} ${result.ok ? "accepted" : "failed"}`);
    } catch (error) {
      console.error(`[codex session ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}`);
      if (command?.id) {
        await postJson("/api/agent/codex/sessions/commands/complete", {
          id: command.id,
          agentId,
          result: {
            ok: false,
            error: error.message
          }
        }).catch(() => {});
      }
      await sleep(2500);
    }
  }
}

async function pollNextCodexJob() {
  const response = await httpFetch(`${config.relayUrl}/api/agent/codex/next?wait=25000`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify({
      agentId,
      workspaces: publicWorkspaces(),
      runtime: publicCodexRuntime()
    }),
    timeoutMs: 35000
  });
  const data = await parseApiResponse(response);
  return data.job || null;
}

async function pollNextCodexSessionCommand() {
  const response = await httpFetch(`${config.relayUrl}/api/agent/codex/sessions/next?wait=25000`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify({
      agentId,
      workspaces: publicWorkspaces(),
      runtime: publicCodexRuntime()
    }),
    timeoutMs: 35000
  });
  const data = await parseApiResponse(response);
  return data.command || null;
}

function startCodexLeaseHeartbeat(jobId) {
  const intervalMs = Math.max(15000, Math.min(Math.floor(config.codex.leaseMs / 2), 30000));
  return setInterval(() => {
    postJson("/api/agent/codex/events", { id: jobId, agentId, events: [] }).catch(() => {});
  }, intervalMs);
}

function startCodexSessionHeartbeat(sessionId) {
  const intervalMs = Math.max(15000, Math.min(Math.floor(config.codex.leaseMs / 2), 30000));
  return setInterval(() => {
    postJson("/api/agent/codex/sessions/events", { id: sessionId, agentId, events: [] }).catch(() => {});
  }, intervalMs);
}

async function postJson(path, body) {
  const response = await httpFetch(`${config.relayUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify(body),
    timeoutMs: 60000
  });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function authHeaders() {
  return { "X-Echo-Token": config.token };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatNetworkStatus(status) {
  if (!status.activeProxyUrl) return `direct, timeout=${status.timeoutMs}ms`;
  const fallback = status.proxyFallbackDirect ? ", direct fallback=on" : "";
  return `proxy=${status.activeProxyUrl}${fallback}, timeout=${status.timeoutMs}ms`;
}
