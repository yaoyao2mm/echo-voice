import { config } from "./config.js";
import { loadDesktopAgentId } from "./lib/agentIdentity.js";
import { CodexInteractiveRuntime } from "./lib/codexInteractiveRunner.js";
import { probeCodexModels } from "./lib/codexModelProbe.js";
import { publicCodexRuntime, publicWorkspaces } from "./lib/codexRunner.js";
import { maybeCleanupCodexSessionWorktrees, prepareCodexSessionWorktree } from "./lib/codexWorktree.js";
import { createManagedWorkspace, workspaceCreationRoot } from "./lib/codexWorkspaceManager.js";
import { describeHttpNetwork, formatFetchError, httpFetch, isLikelyNetworkError } from "./lib/http.js";

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
let codexRuntimeRefreshPromise = null;
let codexRuntimeRefreshTimer = null;
let activeCodexCommandCount = 0;
const runningSessionHeartbeats = new Map();
const completedSessionCommandResults = new Map();

console.log("Echo Codex desktop agent is running.");
console.log(`Relay: ${config.relayUrl}`);
console.log(`Agent ID: ${agentId}`);
console.log(`Network: ${formatNetworkStatus(describeHttpNetwork(config.relayUrl))}`);
console.log(`Codex remote: ${config.codex.enabled ? "enabled" : "disabled"}`);
if (config.codex.enabled) {
  const runtime = currentCodexRuntime();
  console.log(`  command: ${runtime.command || "unavailable"}`);
  if (runtime.commandDetail) {
    console.log(`  app: ${runtime.commandDetail}`);
  }
  console.log(`  model: ${runtime.model || "Codex default"}`);
  console.log("  supported models: syncing when idle");
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
    scheduleCodexRuntimeRefresh();
  }, 10 * 60 * 1000).unref?.();
  scheduleCodexRuntimeRefresh({ delayMs: 30000 });
  runCodexWorkspaceLoop();
  runCodexSessionLoop();
}

async function runCodexWorkspaceLoop() {
  const retryBackoff = createRetryBackoff();

  while (true) {
    let command = null;
    try {
      command = await pollNextCodexWorkspaceCommand();
      retryBackoff.reset();
      if (!command) continue;

      console.log(`[${new Date().toLocaleTimeString()}] codex workspace ${command.type}`);
      const result = await handleCodexWorkspaceCommand(command);
      await postJsonWithRetry("/api/agent/codex/workspaces/commands/complete", {
        id: command.id,
        agentId,
        result,
        workspaces: publicWorkspaces(),
        runtime: currentCodexRuntime()
      });
      console.log(`  workspace ${command.type} ${result.ok ? "completed" : "failed"}`);
    } catch (error) {
      const retryDelayMs = retryBackoff.nextDelay(error);
      console.error(`[codex workspace ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}${retryNote(error, retryDelayMs)}`);
      if (command?.id) {
        await postJsonWithRetry("/api/agent/codex/workspaces/commands/complete", {
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
      await sleep(retryDelayMs);
    }
  }
}

async function runCodexSessionLoop() {
  const runtime = new CodexInteractiveRuntime({
    agentId,
    onEvents: postCodexSessionEvents,
    requestApproval: requestCodexApproval,
    requestInteraction: requestCodexInteraction
  });
  const retryBackoff = createRetryBackoff();

  while (true) {
    let command = null;
    try {
      await maybeCleanupWorktrees();
      command = await pollNextCodexSessionCommand();
      retryBackoff.reset();
      if (!command) continue;

      console.log(`[${new Date().toLocaleTimeString()}] codex session ${command.sessionId} ${command.type}`);
      activeCodexCommandCount += 1;
      const heartbeat = startCodexSessionHeartbeat(command.sessionId);
      try {
        const cachedResult = getCompletedSessionCommandResult(command.id);
        const result = cachedResult || (await runCodexSessionCommand(runtime, command));
        rememberCompletedSessionCommandResult(command.id, result);
        const completed = await postJsonWithRetry("/api/agent/codex/sessions/commands/complete", {
          id: command.id,
          agentId,
          result
        });
        if (completed?.ok === false) {
          console.warn(`  session ${command.type} completion was no longer accepted by relay; cached for replay.`);
          continue;
        }
        forgetCompletedSessionCommandResult(command.id);
        updateRunningSessionHeartbeatFromResult(result.sessionId, result);
        console.log(`  session ${command.type} ${cachedResult ? "replayed" : result.ok ? "accepted" : "failed"}`);
      } finally {
        clearInterval(heartbeat);
        activeCodexCommandCount = Math.max(0, activeCodexCommandCount - 1);
      }
    } catch (error) {
      const retryDelayMs = retryBackoff.nextDelay(error);
      console.error(`[codex session ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}${retryNote(error, retryDelayMs)}`);
      if (command?.sessionId) stopRunningSessionHeartbeat(command.sessionId);
      if (command?.id) {
        await postJsonWithRetry("/api/agent/codex/sessions/commands/complete", {
          id: command.id,
          agentId,
          result: {
            ok: false,
            sessionId: command.sessionId,
            error: error.message
          }
        }).catch(() => {});
      }
      await sleep(retryDelayMs);
    }
  }
}

async function runCodexSessionCommand(runtime, command) {
  const preparedCommand = await prepareCodexSessionWorktree(command);
  const result = await runtime.handleCommand(preparedCommand);
  if (preparedCommand.execution && !result.execution) result.execution = preparedCommand.execution;
  result.sessionId = preparedCommand.sessionId || command.sessionId;
  return result;
}

async function postCodexSessionEvents(sessionId, events = []) {
  updateRunningSessionHeartbeatFromEvents(sessionId, events);
  return postJson("/api/agent/codex/sessions/events", { id: sessionId, agentId, events }).catch(() => {});
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
      agentId,
      sessionId: approval.sessionId
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
  const heartbeat = setInterval(() => {
    postJson("/api/agent/codex/sessions/events", { id: sessionId, agentId, events: [] }).catch(() => {});
  }, intervalMs);
  heartbeat.unref?.();
  return heartbeat;
}

function startRunningSessionHeartbeat(sessionId) {
  if (!sessionId || runningSessionHeartbeats.has(sessionId)) return;
  runningSessionHeartbeats.set(sessionId, startCodexSessionHeartbeat(sessionId));
}

function stopRunningSessionHeartbeat(sessionId) {
  const heartbeat = runningSessionHeartbeats.get(sessionId);
  if (!heartbeat) return;
  clearInterval(heartbeat);
  runningSessionHeartbeats.delete(sessionId);
}

function updateRunningSessionHeartbeatFromResult(sessionId, result = {}) {
  const status = String(result.sessionStatus || "").toLowerCase();
  if (result.ok === true && status === "running") {
    startRunningSessionHeartbeat(sessionId);
    return;
  }
  if (status && status !== "running") stopRunningSessionHeartbeat(sessionId);
}

function updateRunningSessionHeartbeatFromEvents(sessionId, events = []) {
  for (const event of events || []) {
    const method = event?.raw?.method || event?.type || "";
    if (method === "turn/started" || event?.sessionStatus === "running") {
      startRunningSessionHeartbeat(sessionId);
    }
    if (
      method === "turn/completed" ||
      method === "thread/compacted" ||
      method === "turn/interrupt" ||
      event?.clearActiveTurnId ||
      (event?.sessionStatus && event.sessionStatus !== "running")
    ) {
      stopRunningSessionHeartbeat(sessionId);
    }
  }
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

async function postJsonWithRetry(path, body, options = {}) {
  const backoff = createRetryBackoff({ maxMs: Number(options.maxMs || 30000) || 30000 });
  while (true) {
    try {
      return await postJson(path, body);
    } catch (error) {
      if (!isLikelyNetworkError(error)) throw error;
      const retryDelayMs = backoff.nextDelay(error);
      console.error(`[relay post ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}${retryNote(error, retryDelayMs)}`);
      await sleep(retryDelayMs);
    }
  }
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

function createRetryBackoff(options = {}) {
  const baseMs = Number(options.baseMs || 2500) || 2500;
  const maxMs = Number(options.maxMs || 30000) || 30000;
  let nextMs = baseMs;

  return {
    reset() {
      nextMs = baseMs;
    },
    nextDelay(error) {
      if (!isLikelyNetworkError(error)) {
        nextMs = baseMs;
        return baseMs;
      }
      const delayMs = nextMs;
      nextMs = Math.min(maxMs, Math.round(nextMs * 1.8));
      return delayMs;
    }
  };
}

function retryNote(error, delayMs) {
  if (!isLikelyNetworkError(error)) return "";
  return `; retrying in ${Math.round(delayMs / 1000)}s`;
}

function rememberCompletedSessionCommandResult(commandId, result = {}) {
  const id = String(commandId || "").trim();
  if (!id || result.ok !== true) return;
  completedSessionCommandResults.set(id, {
    result: JSON.parse(JSON.stringify(result)),
    expiresAt: Date.now() + Math.max(config.codex.leaseMs * 2, 30 * 60 * 1000)
  });
  pruneCompletedSessionCommandResults();
}

function getCompletedSessionCommandResult(commandId) {
  const id = String(commandId || "").trim();
  if (!id) return null;
  const cached = completedSessionCommandResults.get(id);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    completedSessionCommandResults.delete(id);
    return null;
  }
  return JSON.parse(JSON.stringify(cached.result));
}

function forgetCompletedSessionCommandResult(commandId) {
  const id = String(commandId || "").trim();
  if (id) completedSessionCommandResults.delete(id);
}

function pruneCompletedSessionCommandResults() {
  const now = Date.now();
  for (const [id, cached] of completedSessionCommandResults) {
    if (cached.expiresAt <= now) completedSessionCommandResults.delete(id);
  }
}

function currentCodexRuntime() {
  return codexRuntimeStatus;
}

async function refreshCodexRuntimeStatus() {
  const runtime = publicCodexRuntime();
  const previous = codexRuntimeStatus || {};
  if (!runtime.command) {
    codexRuntimeStatus = runtime;
    return runtime;
  }
  if (activeCodexCommandCount > 0 || runningSessionHeartbeats.size > 0) {
    codexRuntimeStatus = {
      ...runtime,
      supportedModels: previous.supportedModels || [],
      modelCapabilitySource: previous.modelCapabilitySource || "deferred",
      modelCapabilityCheckedAt: previous.modelCapabilityCheckedAt || "",
      modelCapabilityError: previous.modelCapabilityError || ""
    };
    return codexRuntimeStatus;
  }
  if (codexRuntimeRefreshPromise) return codexRuntimeRefreshPromise;

  codexRuntimeRefreshPromise = (async () => {
    try {
      const supportedModels = await probeCodexModels({ timeoutMs: 15000 });
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
        supportedModels: previous.supportedModels || [],
        modelCapabilitySource: "unavailable",
        modelCapabilityCheckedAt: new Date().toISOString(),
        modelCapabilityError: error.message
      };
    }
    return codexRuntimeStatus;
  })().finally(() => {
    codexRuntimeRefreshPromise = null;
  });

  return codexRuntimeRefreshPromise;
}

function scheduleCodexRuntimeRefresh(options = {}) {
  if (codexRuntimeRefreshTimer) return;
  const delayMs = Math.max(0, Number(options.delayMs || 0) || 0);
  codexRuntimeRefreshTimer = setTimeout(() => {
    codexRuntimeRefreshTimer = null;
    refreshCodexRuntimeStatus().catch((error) => {
      console.error(`[codex runtime refresh] ${error.message}`);
    });
  }, delayMs);
  codexRuntimeRefreshTimer.unref?.();
}

function formatNetworkStatus(status) {
  if (!status.activeProxyUrl) return `direct, timeout=${status.timeoutMs}ms`;
  const fallback = status.proxyFallbackDirect ? ", direct fallback=on" : "";
  return `proxy=${status.activeProxyUrl}${fallback}, timeout=${status.timeoutMs}ms`;
}
