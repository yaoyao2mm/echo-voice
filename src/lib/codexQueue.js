import { EventEmitter } from "node:events";
import {
  acquireNextJob,
  acquireNextSessionCommand,
  appendEvents as appendStoredEvents,
  appendSessionEvents as appendStoredSessionEvents,
  completeJob as completeStoredJob,
  completeSessionCommand as completeStoredSessionCommand,
  createJob as createStoredJob,
  createSessionApproval as createStoredSessionApproval,
  createSession as createStoredSession,
  decideSessionApproval as decideStoredSessionApproval,
  enqueueSessionMessage as enqueueStoredSessionMessage,
  getJob as getStoredJob,
  getSession as getStoredSession,
  listJobs as listStoredJobs,
  listSessions as listStoredSessions,
  statusSnapshot,
  touchAgent,
  upsertAgent,
  waitForSessionApprovalDecision as getStoredApprovalDecision
} from "./codexStore.js";

const events = new EventEmitter();

export function updateCodexAgent(input = {}) {
  return upsertAgent(input);
}

export function codexStatus() {
  return statusSnapshot();
}

export function createCodexJob(input) {
  const prompt = String(input.prompt || "").trim();
  const projectId = String(input.projectId || "").trim();
  if (!prompt) {
    const error = new Error("Codex task prompt is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!projectId) {
    const error = new Error("Codex project is required.");
    error.statusCode = 400;
    throw error;
  }

  const job = createStoredJob({ projectId, prompt });
  events.emit("codex-job");
  return job;
}

export function createCodexSession(input) {
  const prompt = String(input.prompt || "").trim();
  const projectId = String(input.projectId || "").trim();
  if (!prompt) {
    const error = new Error("Codex session prompt is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!projectId) {
    const error = new Error("Codex project is required.");
    error.statusCode = 400;
    throw error;
  }

  const session = createStoredSession({ projectId, prompt });
  events.emit("codex-session-command");
  return session;
}

export function enqueueCodexSessionMessage(id, input = {}) {
  const session = enqueueStoredSessionMessage(id, input.text || input.prompt || "");
  events.emit("codex-session-command");
  return session;
}

export function listCodexJobs(limit = 20) {
  return listStoredJobs(limit);
}

export function listCodexSessions(limit = 20) {
  return listStoredSessions(limit);
}

export function getCodexJob(id) {
  return getStoredJob(id);
}

export function getCodexSession(id) {
  return getStoredSession(id);
}

export async function waitForCodexJob(input = {}) {
  const agent = updateCodexAgent(input.agent || {});
  const immediateJob = acquireNextJob({ agentId: agent.id, workspaces: agent.workspaces });
  if (immediateJob) return buildAgentJob(immediateJob);

  const waitMs = clampWaitMs(input.waitMs);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      events.off("codex-job", handleJob);
      resolve(null);
    }, waitMs);

    function handleJob() {
      const job = acquireNextJob({ agentId: agent.id, workspaces: agent.workspaces });
      if (!job) return;
      clearTimeout(timeout);
      events.off("codex-job", handleJob);
      resolve(buildAgentJob(job));
    }

    events.on("codex-job", handleJob);
  });
}

export async function waitForCodexSessionCommand(input = {}) {
  const agent = updateCodexAgent(input.agent || {});
  const immediateCommand = acquireNextSessionCommand({ agentId: agent.id, workspaces: agent.workspaces });
  if (immediateCommand) return immediateCommand;

  const waitMs = clampWaitMs(input.waitMs);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      events.off("codex-session-command", handleCommand);
      resolve(null);
    }, waitMs);

    function handleCommand() {
      const command = acquireNextSessionCommand({ agentId: agent.id, workspaces: agent.workspaces });
      if (!command) return;
      clearTimeout(timeout);
      events.off("codex-session-command", handleCommand);
      resolve(command);
    }

    events.on("codex-session-command", handleCommand);
  });
}

export function appendCodexEvents(id, incomingEvents = [], options = {}) {
  if (options.agent) updateCodexAgent(options.agent);
  else if (options.agentId) touchAgent(options.agentId);
  return appendStoredEvents(id, incomingEvents, { agentId: options.agentId || options.agent?.id });
}

export function appendCodexSessionEvents(id, incomingEvents = [], options = {}) {
  if (options.agent) updateCodexAgent(options.agent);
  else if (options.agentId) touchAgent(options.agentId);
  return appendStoredSessionEvents(id, incomingEvents, { agentId: options.agentId || options.agent?.id });
}

export function createCodexSessionApproval(input = {}, options = {}) {
  if (options.agent) updateCodexAgent(options.agent);
  else if (options.agentId) touchAgent(options.agentId);
  const approval = createStoredSessionApproval(input, { agentId: options.agentId || options.agent?.id });
  if (approval) events.emit(`codex-approval-${approval.id}`);
  return approval;
}

export function decideCodexSessionApproval(id, input = {}, options = {}) {
  const approval = decideStoredSessionApproval(id, input, options);
  if (approval) events.emit(`codex-approval-${approval.id}`);
  return approval;
}

export async function waitForCodexSessionApproval(id, input = {}) {
  if (input.agent) updateCodexAgent(input.agent);
  else if (input.agentId) touchAgent(input.agentId);

  const immediateApproval = getStoredApprovalDecision(id, { agentId: input.agentId || input.agent?.id });
  if (immediateApproval) return immediateApproval;

  const waitMs = clampWaitMs(input.waitMs);
  return new Promise((resolve) => {
    const eventName = `codex-approval-${id}`;
    const timeout = setTimeout(() => {
      events.off(eventName, handleDecision);
      resolve(null);
    }, waitMs);

    function handleDecision() {
      const approval = getStoredApprovalDecision(id, { agentId: input.agentId || input.agent?.id });
      if (!approval) return;
      clearTimeout(timeout);
      events.off(eventName, handleDecision);
      resolve(approval);
    }

    events.on(eventName, handleDecision);
  });
}

export function completeCodexJob(id, result = {}, options = {}) {
  if (options.agent) updateCodexAgent(options.agent);
  else if (options.agentId) touchAgent(options.agentId);
  const ok = completeStoredJob(id, result, { agentId: options.agentId || options.agent?.id });
  if (ok) events.emit("codex-job");
  return ok;
}

export function completeCodexSessionCommand(id, result = {}, options = {}) {
  if (options.agent) updateCodexAgent(options.agent);
  else if (options.agentId) touchAgent(options.agentId);
  const ok = completeStoredSessionCommand(id, result, { agentId: options.agentId || options.agent?.id });
  if (ok) events.emit("codex-session-command");
  return ok;
}

function buildAgentJob(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    prompt: job.prompt,
    createdAt: job.createdAt
  };
}

function clampWaitMs(value) {
  const waitMs = Number(value);
  if (!Number.isFinite(waitMs)) return 25000;
  return Math.max(1000, Math.min(waitMs, 30000));
}
