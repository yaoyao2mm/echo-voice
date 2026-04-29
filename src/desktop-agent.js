import { config } from "./config.js";
import { loadDesktopAgentId } from "./lib/agentIdentity.js";
import { CodexInteractiveRuntime } from "./lib/codexInteractiveRunner.js";
import { publicCodexRuntime, publicWorkspaces } from "./lib/codexRunner.js";
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
  console.log(`  reasoning: ${runtime.reasoningEffort || "Codex default"}`);
  console.log(`  sandbox: ${runtime.sandbox}`);
  for (const workspace of publicWorkspaces()) {
    console.log(`  ${workspace.id}: ${workspace.path}`);
  }
}
console.log("Waiting for mobile Codex tasks.\n");

if (config.codex.enabled) {
  runCodexSessionLoop();
}

async function runCodexSessionLoop() {
  const runtime = new CodexInteractiveRuntime({
    agentId,
    onEvents: (id, events) => postJson("/api/agent/codex/sessions/events", { id, agentId, events }).catch(() => {}),
    requestApproval: requestCodexApproval
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

async function requestCodexApproval(approval) {
  const created = await postJson("/api/agent/codex/sessions/approvals", {
    agentId,
    sessionId: approval.sessionId,
    appRequestId: approval.appRequestId,
    method: approval.method,
    prompt: approval.prompt,
    payload: approval.payload
  });

  const approvalId = created.approval?.id;
  if (!approvalId) throw new Error("Relay did not create a Codex approval request.");

  const started = Date.now();
  const timeoutMs = config.codex.approvalTimeoutMs;
  while (Date.now() - started < timeoutMs) {
    const waited = await postJson(`/api/agent/codex/sessions/approvals/${encodeURIComponent(approvalId)}/wait?wait=25000`, {
      agentId
    });
    if (waited.approval?.response) return waited.approval.response;
  }

  return approval.method === "execCommandApproval" || approval.method === "applyPatchApproval"
    ? { decision: "timed_out" }
    : { decision: "cancel" };
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
