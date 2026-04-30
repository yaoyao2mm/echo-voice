import { EventEmitter } from "node:events";
import {
  acquireNextSessionCommand,
  appendSessionEvents as appendStoredSessionEvents,
  archiveSession as archiveStoredSession,
  completeSessionCommand as completeStoredSessionCommand,
  completeWorkspaceCommand as completeStoredWorkspaceCommand,
  createSessionApproval as createStoredSessionApproval,
  createSession as createStoredSession,
  createWorkspaceCommand as createStoredWorkspaceCommand,
  decideSessionApproval as decideStoredSessionApproval,
  enqueueSessionMessage as enqueueStoredSessionMessage,
  getWorkspaceCommand as getStoredWorkspaceCommand,
  getSessionAttachmentContent as getStoredSessionAttachmentContent,
  getSession as getStoredSession,
  listSessions as listStoredSessions,
  acquireNextWorkspaceCommand,
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

export function createCodexSession(input) {
  const prompt = String(input.prompt || "").trim();
  const projectId = String(input.projectId || "").trim();
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  if (!prompt && attachments.length === 0) {
    const error = new Error("Codex session prompt or screenshot is required.");
    error.statusCode = 400;
    throw error;
  }
  if (!projectId) {
    const error = new Error("Codex project is required.");
    error.statusCode = 400;
    throw error;
  }

  const session = createStoredSession({ projectId, prompt, attachments, runtime: input.runtime || {} });
  events.emit("codex-session-command");
  return session;
}

export function enqueueCodexSessionMessage(id, input = {}) {
  const session = enqueueStoredSessionMessage(id, {
    text: input.text || input.prompt || "",
    attachments: input.attachments,
    runtime: input.runtime || {}
  });
  events.emit("codex-session-command");
  return session;
}

export function listCodexSessions(limit = 20, options = {}) {
  return listStoredSessions(limit, options);
}

export function getCodexSession(id) {
  return getStoredSession(id);
}

export function getCodexSessionAttachmentContent(id) {
  return getStoredSessionAttachmentContent(id);
}

export function createCodexWorkspace(input = {}) {
  const command = createStoredWorkspaceCommand(input);
  events.emit("codex-workspace-command");
  return command;
}

export function getCodexWorkspaceCommand(id) {
  return getStoredWorkspaceCommand(id);
}

export async function waitForCodexWorkspaceCommand(input = {}) {
  const agent = updateCodexAgent(input.agent || {});
  const immediateCommand = acquireNextWorkspaceCommand({ agentId: agent.id });
  if (immediateCommand) return immediateCommand;

  const waitMs = clampWaitMs(input.waitMs);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      events.off("codex-workspace-command", handleCommand);
      resolve(null);
    }, waitMs);

    function handleCommand() {
      const command = acquireNextWorkspaceCommand({ agentId: agent.id });
      if (!command) return;
      clearTimeout(timeout);
      events.off("codex-workspace-command", handleCommand);
      resolve(command);
    }

    events.on("codex-workspace-command", handleCommand);
  });
}

export function completeCodexWorkspaceCommand(id, result = {}, options = {}) {
  if (options.agent) updateCodexAgent(options.agent);
  else if (options.agentId) touchAgent(options.agentId);
  const ok = completeStoredWorkspaceCommand(id, result, { agentId: options.agentId || options.agent?.id });
  if (ok) events.emit("codex-workspace-command");
  return ok;
}

export function archiveCodexSession(id, input = {}) {
  const session = archiveStoredSession(id, input);
  if (session) events.emit("codex-session-command");
  return session;
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

export function completeCodexSessionCommand(id, result = {}, options = {}) {
  if (options.agent) updateCodexAgent(options.agent);
  else if (options.agentId) touchAgent(options.agentId);
  const ok = completeStoredSessionCommand(id, result, { agentId: options.agentId || options.agent?.id });
  if (ok) events.emit("codex-session-command");
  return ok;
}

function clampWaitMs(value) {
  const waitMs = Number(value);
  if (!Number.isFinite(waitMs)) return 25000;
  return Math.max(1000, Math.min(waitMs, 30000));
}
