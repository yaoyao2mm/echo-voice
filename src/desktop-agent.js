import { config } from "./config.js";
import { loadDesktopAgentId } from "./lib/agentIdentity.js";
import { CodexInteractiveRuntime } from "./lib/codexInteractiveRunner.js";
import { listWorkspaceFiles, readWorkspaceFile } from "./lib/codexFileBrowser.js";
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
const activeSessionCommands = new Map();
const runningSessionHeartbeats = new Map();
const runningSessionStates = new Map();
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
  console.log(`  session concurrency: ${Math.max(1, Number(config.codex.sessionConcurrency || 1))}`);
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
  runCodexFileLoop();
  runCodexSessionLoops();
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

async function runCodexFileLoop() {
  const retryBackoff = createRetryBackoff();

  while (true) {
    let request = null;
    try {
      request = await pollNextCodexFileRequest();
      retryBackoff.reset();
      if (!request) continue;

      console.log(`[${new Date().toLocaleTimeString()}] codex files ${request.type} ${request.projectId}:${request.path || "/"}`);
      const result = await handleCodexFileRequest(request);
      await postJsonWithRetry("/api/agent/codex/files/requests/complete", {
        id: request.id,
        agentId,
        result,
        workspaces: publicWorkspaces(),
        runtime: currentCodexRuntime()
      });
      console.log(`  files ${request.type} ${result.ok ? "completed" : "failed"}`);
    } catch (error) {
      const retryDelayMs = retryBackoff.nextDelay(error);
      console.error(`[codex files ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}${retryNote(error, retryDelayMs)}`);
      if (request?.id) {
        await postJsonWithRetry("/api/agent/codex/files/requests/complete", {
          id: request.id,
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

function runCodexSessionLoops() {
  const runtime = new CodexInteractiveRuntime({
    agentId,
    onEvents: postCodexSessionEvents,
    requestApproval: requestCodexApproval,
    requestInteraction: requestCodexInteraction
  });
  const concurrency = Math.max(1, Number(config.codex.sessionConcurrency || 1));
  for (let index = 0; index < concurrency; index += 1) {
    runCodexSessionWorker(runtime, index + 1).catch((error) => {
      console.error(`[codex session worker ${index + 1}] stopped unexpectedly: ${error.message}`);
    });
  }
}

async function runCodexSessionWorker(runtime, workerId) {
  const retryBackoff = createRetryBackoff();

  while (true) {
    let command = null;
    try {
      await maybeCleanupWorktrees();
      command = await pollNextCodexSessionCommand();
      retryBackoff.reset();
      if (!command) continue;

      console.log(`[${new Date().toLocaleTimeString()}] codex session ${command.sessionId} ${command.type} worker=${workerId}`);
      activeCodexCommandCount += 1;
      rememberActiveSessionCommand(command);
      const heartbeat = startCodexSessionHeartbeat(command.sessionId);
      try {
        const cachedResult = getCompletedSessionCommandResult(command.id);
        const result = cachedResult || (await runCodexSessionCommand(runtime, command));
        if (!result.projectId) result.projectId = command.projectId;
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
        updateRunningSessionHeartbeatFromResult(result.sessionId, result, command);
        console.log(`  session ${command.type} ${cachedResult ? "replayed" : result.ok ? "accepted" : "failed"}`);
      } finally {
        clearInterval(heartbeat);
        forgetActiveSessionCommand(command.id);
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
  result.projectId = preparedCommand.projectId || command.projectId;
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

async function handleCodexFileRequest(request) {
  const payload = request.payload || {};
  try {
    if (request.type === "list") {
      return await listWorkspaceFiles({
        projectId: request.projectId,
        relativePath: payload.path ?? request.path,
        maxEntries: payload.maxEntries,
        workspaces: publicWorkspaces()
      });
    }
    if (request.type === "read") {
      return await readWorkspaceFile({
        projectId: request.projectId,
        relativePath: payload.path ?? request.path,
        maxBytes: payload.maxBytes,
        workspaces: publicWorkspaces()
      });
    }
    return { ok: false, error: `Unsupported file browser request: ${request.type}` };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code || "" };
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

async function pollNextCodexFileRequest() {
  const response = await httpFetch(`${config.relayUrl}/api/agent/codex/files/next?wait=25000`, {
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
  return data.request || null;
}

async function pollNextCodexSessionCommand() {
  const scheduling = codexSchedulingSnapshot();
  const waitMs = scheduling.busyProjectIds.length > 0 || scheduling.busySessionIds.length > 0 ? 5000 : 25000;
  const response = await httpFetch(`${config.relayUrl}/api/agent/codex/sessions/next?wait=${waitMs}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify({
      agentId,
      workspaces: publicWorkspaces(),
      runtime: currentCodexRuntime(),
      ...scheduling
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

function startRunningSessionHeartbeat(sessionId, details = {}) {
  if (!sessionId || runningSessionHeartbeats.has(sessionId)) return;
  runningSessionHeartbeats.set(sessionId, startCodexSessionHeartbeat(sessionId));
  rememberRunningSessionState(sessionId, details);
}

function stopRunningSessionHeartbeat(sessionId) {
  const heartbeat = runningSessionHeartbeats.get(sessionId);
  if (!heartbeat) {
    runningSessionStates.delete(sessionId);
    return;
  }
  clearInterval(heartbeat);
  runningSessionHeartbeats.delete(sessionId);
  runningSessionStates.delete(sessionId);
}

function updateRunningSessionHeartbeatFromResult(sessionId, result = {}, command = {}) {
  const status = String(result.sessionStatus || "").toLowerCase();
  if (result.ok === true && status === "running") {
    const state = sessionWorkStateFromCommand(command, result);
    startRunningSessionHeartbeat(sessionId, state);
    rememberRunningSessionState(sessionId, state);
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

function rememberActiveSessionCommand(command = {}) {
  const commandId = String(command.id || "").trim();
  if (!commandId) return;
  activeSessionCommands.set(commandId, sessionWorkStateFromCommand(command));
}

function forgetActiveSessionCommand(commandId) {
  const id = String(commandId || "").trim();
  if (id) activeSessionCommands.delete(id);
}

function rememberRunningSessionState(sessionId, details = {}) {
  const id = String(sessionId || "").trim();
  if (!id) return;
  const previous = runningSessionStates.get(id) || {};
  runningSessionStates.set(id, {
    ...previous,
    ...details,
    sessionId: id,
    isolated: Boolean(details.isolated ?? previous.isolated)
  });
}

function activeCodexSessionIds() {
  return Array.from(new Set([...activeSessionCommands.values()].map((item) => item.sessionId).filter(Boolean)));
}

function runningCodexSessionIds() {
  return [...runningSessionStates.keys()];
}

function busyCodexProjectIds() {
  const ids = new Set();
  for (const item of [...activeSessionCommands.values(), ...runningSessionStates.values()]) {
    if (item.projectId && !item.isolated) ids.add(item.projectId);
  }
  return [...ids];
}

function codexSchedulingSnapshot() {
  return {
    busySessionIds: activeCodexSessionIds(),
    busyProjectIds: busyCodexProjectIds(),
    runningSessionIds: runningCodexSessionIds()
  };
}

function sessionWorkStateFromCommand(command = {}, result = {}) {
  const execution = result.execution || command.execution || {};
  return {
    sessionId: String(result.sessionId || command.sessionId || "").trim(),
    projectId: String(result.projectId || command.projectId || execution.baseWorkspaceId || "").trim(),
    isolated: isIsolatedSessionExecution(command, result)
  };
}

function isIsolatedSessionExecution(command = {}, result = {}) {
  const execution = result.execution || command.execution || {};
  if (execution?.mode === "worktree" || execution?.path) return true;
  return command.type === "start" && String(command.runtime?.worktreeMode || "").trim() === "always";
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
