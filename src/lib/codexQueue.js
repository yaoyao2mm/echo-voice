import { EventEmitter } from "node:events";
import {
  acquireNextSessionCommand,
  appendSessionEvents as appendStoredSessionEvents,
  archiveSession as archiveStoredSession,
  cancelSession as cancelStoredSession,
  compactSession as compactStoredSession,
  completeSessionCommand as completeStoredSessionCommand,
  completeWorkspaceCommand as completeStoredWorkspaceCommand,
  createSessionInteraction as createStoredSessionInteraction,
  createSessionApproval as createStoredSessionApproval,
  createSession as createStoredSession,
  createWorkspaceCommand as createStoredWorkspaceCommand,
  decideSessionInteraction as decideStoredSessionInteraction,
  decideSessionApproval as decideStoredSessionApproval,
  enqueueSessionMessage as enqueueStoredSessionMessage,
  getWorkspaceCommand as getStoredWorkspaceCommand,
  getSessionCommandSessionId as getStoredSessionCommandSessionId,
  getSessionAttachmentContent as getStoredSessionAttachmentContent,
  getSession as getStoredSession,
  listSessions as listStoredSessions,
  acquireNextWorkspaceCommand,
  statusSnapshot,
  touchAgent,
  upsertAgent,
  waitForSessionApprovalDecision as getStoredApprovalDecision,
  waitForSessionInteractionDecision as getStoredInteractionDecision
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

  const session = createStoredSession({ projectId, prompt, attachments, runtime: input.runtime || {}, mode: input.mode });
  events.emit("codex-session-command");
  notifySessionChanged(session?.id);
  return session;
}

export function enqueueCodexSessionMessage(id, input = {}) {
  const session = enqueueStoredSessionMessage(id, {
    text: input.text || input.prompt || "",
    attachments: input.attachments,
    runtime: input.runtime || {},
    mode: input.mode,
    projectId: input.projectId
  });
  events.emit("codex-session-command");
  notifySessionChanged(session?.id);
  return session;
}

export function listCodexSessions(limit = 20, options = {}) {
  return listStoredSessions(limit, options);
}

export function getCodexSession(id, options = {}) {
  return getStoredSession(id, options);
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
  notifySessionChanged(session?.id || id);
  return session;
}

export function compactCodexSession(id, input = {}) {
  const session = compactStoredSession(id, input);
  if (session) events.emit("codex-session-command");
  notifySessionChanged(session?.id || id);
  return session;
}

export function cancelCodexSession(id, input = {}) {
  const session = cancelStoredSession(id, input);
  if (session) events.emit("codex-session-command");
  notifySessionChanged(session?.id || id);
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
  const ok = appendStoredSessionEvents(id, incomingEvents, { agentId: options.agentId || options.agent?.id });
  if (ok) notifySessionChanged(id);
  return ok;
}

export function createCodexSessionApproval(input = {}, options = {}) {
  if (options.agent) updateCodexAgent(options.agent);
  else if (options.agentId) touchAgent(options.agentId);
  const approval = createStoredSessionApproval(input, { agentId: options.agentId || options.agent?.id });
  if (approval) events.emit(`codex-approval-${approval.id}`);
  notifySessionChanged(approval?.sessionId);
  return approval;
}

export function decideCodexSessionApproval(id, input = {}, options = {}) {
  const approval = decideStoredSessionApproval(id, input, options);
  if (approval) events.emit(`codex-approval-${approval.id}`);
  notifySessionChanged(approval?.sessionId);
  return approval;
}

export function createCodexSessionInteraction(input = {}, options = {}) {
  if (options.agent) updateCodexAgent(options.agent);
  else if (options.agentId) touchAgent(options.agentId);
  const interaction = createStoredSessionInteraction(input, { agentId: options.agentId || options.agent?.id });
  if (interaction) events.emit(`codex-interaction-${interaction.id}`);
  notifySessionChanged(interaction?.sessionId);
  return interaction;
}

export function decideCodexSessionInteraction(id, input = {}, options = {}) {
  const interaction = decideStoredSessionInteraction(id, input, options);
  if (interaction) events.emit(`codex-interaction-${interaction.id}`);
  notifySessionChanged(interaction?.sessionId);
  return interaction;
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

export async function waitForCodexSessionInteraction(id, input = {}) {
  if (input.agent) updateCodexAgent(input.agent);
  else if (input.agentId) touchAgent(input.agentId);

  const immediateInteraction = getStoredInteractionDecision(id, { agentId: input.agentId || input.agent?.id });
  if (immediateInteraction) return immediateInteraction;

  const waitMs = clampWaitMs(input.waitMs);
  return new Promise((resolve) => {
    const eventName = `codex-interaction-${id}`;
    const sessionEventName = input.sessionId ? sessionChangedEventName(input.sessionId) : "";
    const timeout = setTimeout(() => {
      events.off(eventName, handleDecision);
      if (sessionEventName) events.off(sessionEventName, handleDecision);
      resolve(null);
    }, waitMs);

    function handleDecision() {
      const interaction = getStoredInteractionDecision(id, { agentId: input.agentId || input.agent?.id });
      if (!interaction) return;
      clearTimeout(timeout);
      events.off(eventName, handleDecision);
      if (sessionEventName) events.off(sessionEventName, handleDecision);
      resolve(interaction);
    }

    events.on(eventName, handleDecision);
    if (sessionEventName) events.on(sessionEventName, handleDecision);
  });
}

export function completeCodexSessionCommand(id, result = {}, options = {}) {
  if (options.agent) updateCodexAgent(options.agent);
  else if (options.agentId) touchAgent(options.agentId);
  const sessionId = result?.sessionId || getStoredSessionCommandSessionId(id);
  const ok = completeStoredSessionCommand(id, result, { agentId: options.agentId || options.agent?.id });
  if (ok) events.emit("codex-session-command");
  if (ok && sessionId) notifySessionChanged(sessionId);
  return ok;
}

export function subscribeCodexSession(id, listener) {
  const eventName = sessionChangedEventName(id);
  events.on(eventName, listener);
  return () => events.off(eventName, listener);
}

function notifySessionChanged(id) {
  const sessionId = String(id || "").trim();
  if (!sessionId) return;
  events.emit(sessionChangedEventName(sessionId), sessionId);
}

function sessionChangedEventName(id) {
  return `codex-session-changed-${id}`;
}

function clampWaitMs(value) {
  const waitMs = Number(value);
  if (!Number.isFinite(waitMs)) return 25000;
  return Math.max(1000, Math.min(waitMs, 30000));
}
