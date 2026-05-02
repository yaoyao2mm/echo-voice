import { config } from "./config.js";
import { loadDesktopAgentId } from "./lib/agentIdentity.js";
import { CodexInteractiveRuntime } from "./lib/codexInteractiveRunner.js";
import { probeCodexModels } from "./lib/codexModelProbe.js";
import { publicCodexRuntime, publicWorkspaces } from "./lib/codexRunner.js";
import { maybeCleanupCodexSessionWorktrees, prepareCodexSessionWorktree } from "./lib/codexWorktree.js";
import { createManagedWorkspace, workspaceCreationRoot } from "./lib/codexWorkspaceManager.js";
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
let codexRuntimeStatus = publicCodexRuntime();

console.log("Echo Codex desktop agent is running.");
console.log(`Relay: ${config.relayUrl}`);
console.log(`Agent ID: ${agentId}`);
console.log(`Network: ${formatNetworkStatus(describeHttpNetwork(config.relayUrl))}`);
console.log(`Codex remote: ${config.codex.enabled ? "enabled" : "disabled"}`);
if (config.codex.enabled) {
  await refreshCodexRuntimeStatus();
  const runtime = currentCodexRuntime();
  console.log(`  command: ${runtime.command || "unavailable"}`);
  if (runtime.commandDetail) {
    console.log(`  app: ${runtime.commandDetail}`);
  }
  console.log(`  model: ${runtime.model || "Codex default"}`);
  console.log(`  supported models: ${runtime.supportedModels?.length || 0}`);
  console.log(`  permissions: ${(runtime.allowedPermissionModes || []).join(", ") || "none"}`);
  console.log(`  reasoning: ${runtime.reasoningEffort || "Codex default"}`);
  console.log(`  sandbox: ${runtime.sandbox}`);
  for (const workspace of publicWorkspaces()) {
    console.log(`  ${workspace.id}: ${workspace.path}`);
  }
  console.log(`  new workspace root: ${workspaceCreationRoot()}`);
  if (!runtime.command) {
    console.error("Codex remote cannot start because the official Codex app is not available.");
    process.exit(1);
  }
}
console.log("Waiting for mobile Codex tasks.\n");

if (config.codex.enabled) {
  setInterval(() => {
    refreshCodexRuntimeStatus().catch((error) => {
      console.error(`[codex runtime refresh] ${error.message}`);
    });
  }, 10 * 60 * 1000).unref?.();
  runCodexWorkspaceLoop();
  runCodexSessionLoop();
}

async function runCodexWorkspaceLoop() {
  while (true) {
    let command = null;
    try {
      command = await pollNextCodexWorkspaceCommand();
      if (!command) continue;

      console.log(`[${new Date().toLocaleTimeString()}] codex workspace ${command.type}`);
      const result = await handleCodexWorkspaceCommand(command);
      await postJson("/api/agent/codex/workspaces/commands/complete", {
        id: command.id,
        agentId,
        result,
        workspaces: publicWorkspaces(),
        runtime: currentCodexRuntime()
      });
      console.log(`  workspace ${command.type} ${result.ok ? "completed" : "failed"}`);
    } catch (error) {
      console.error(`[codex workspace ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}`);
      if (command?.id) {
        await postJson("/api/agent/codex/workspaces/commands/complete", {
          id: command.id,
          agentId,
          result: {
            ok: false,
            error: error.message
          },
          workspaces: publicWorkspaces(),
          runtime: currentCodexRuntime()
        }).catch(() => {});
      }
      await sleep(2500);
    }
  }
}

async function runCodexSessionLoop() {
  const runtime = new CodexInteractiveRuntime({
    agentId,
    onEvents: (id, events) => postJson("/api/agent/codex/sessions/events", { id, agentId, events }).catch(() => {}),
    requestApproval: requestCodexApproval,
    requestInteraction: requestCodexInteraction
  });

  while (true) {
    let command = null;
    try {
      await maybeCleanupWorktrees();
      command = await pollNextCodexSessionCommand();
      if (!command) continue;

      console.log(`[${new Date().toLocaleTimeString()}] codex session ${command.sessionId} ${command.type}`);
      const heartbeat = startCodexSessionHeartbeat(command.sessionId);
      const preparedCommand = await prepareCodexSessionWorktree(command);
      const result = await runtime.handleCommand(preparedCommand).finally(() => clearInterval(heartbeat));
      if (preparedCommand.execution && !result.execution) result.execution = preparedCommand.execution;
      result.sessionId = preparedCommand.sessionId || command.sessionId;
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
            sessionId: command.sessionId,
            error: error.message
          }
        }).catch(() => {});
      }
      await sleep(2500);
    }
  }
}

async function handleCodexWorkspaceCommand(command) {
  if (command.type !== "create") {
    return { ok: false, error: `Unsupported workspace command: ${command.type}` };
  }
  const workspace = createManagedWorkspace(command.payload || {});
  return { ok: true, workspace };
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

async function requestCodexInteraction(interaction) {
  const created = await postJson("/api/agent/codex/sessions/interactions", {
    agentId,
    sessionId: interaction.sessionId,
    appRequestId: interaction.appRequestId,
    method: interaction.method,
    kind: interaction.kind,
    prompt: interaction.prompt,
    payload: interaction.payload
  });

  const interactionId = created.interaction?.id;
  if (!interactionId) throw new Error("Relay did not create a Codex interaction request.");

  const started = Date.now();
  const timeoutMs = config.codex.approvalTimeoutMs;
  while (Date.now() - started < timeoutMs) {
    const waited = await postJson(`/api/agent/codex/sessions/interactions/${encodeURIComponent(interactionId)}/wait?wait=25000`, {
      agentId,
      sessionId: interaction.sessionId
    });
    if (waited.interaction?.response) return waited.interaction.response;
  }

  return interaction.kind === "user_input" ? { answers: {} } : {};
}

async function pollNextCodexWorkspaceCommand() {
  const response = await httpFetch(`${config.relayUrl}/api/agent/codex/workspaces/next?wait=25000`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify({
      agentId,
      workspaces: publicWorkspaces(),
      runtime: currentCodexRuntime()
    }),
    timeoutMs: 35000
  });
  const data = await parseApiResponse(response);
  return data.command || null;
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
      runtime: currentCodexRuntime()
    }),
    timeoutMs: 35000
  });
  const data = await parseApiResponse(response);
  return data.command || null;
}

async function maybeCleanupWorktrees() {
  const result = await maybeCleanupCodexSessionWorktrees().catch((error) => {
    console.error(`[codex worktree cleanup] ${error.message}`);
    return null;
  });
  if (!result?.removed) return;
  console.log(
    `[codex worktree cleanup] removed ${result.removed} old clean worktree${result.removed === 1 ? "" : "s"}`
  );
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

function currentCodexRuntime() {
  return codexRuntimeStatus;
}

async function refreshCodexRuntimeStatus() {
  const runtime = publicCodexRuntime();
  if (!runtime.command) {
    codexRuntimeStatus = runtime;
    return runtime;
  }

  try {
    const supportedModels = await probeCodexModels({ timeoutMs: 30000 });
    codexRuntimeStatus = {
      ...runtime,
      supportedModels,
      modelCapabilitySource: "codex-app-server",
      modelCapabilityCheckedAt: new Date().toISOString(),
      modelCapabilityError: ""
    };
  } catch (error) {
    codexRuntimeStatus = {
      ...runtime,
      supportedModels: [],
      modelCapabilitySource: "unavailable",
      modelCapabilityCheckedAt: new Date().toISOString(),
      modelCapabilityError: error.message
    };
  }
  return codexRuntimeStatus;
}

function formatNetworkStatus(status) {
  if (!status.activeProxyUrl) return `direct, timeout=${status.timeoutMs}ms`;
  const fallback = status.proxyFallbackDirect ? ", direct fallback=on" : "";
  return `proxy=${status.activeProxyUrl}${fallback}, timeout=${status.timeoutMs}ms`;
}
