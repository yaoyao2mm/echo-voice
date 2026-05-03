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
  createQuickSkill as createStoredQuickSkill,
  createSession as createStoredSession,
  createWorkspaceCommand as createStoredWorkspaceCommand,
  deleteQuickSkill as deleteStoredQuickSkill,
  decideSessionInteraction as decideStoredSessionInteraction,
  decideSessionApproval as decideStoredSessionApproval,
  enqueueSessionMessage as enqueueStoredSessionMessage,
  getWorkspaceCommand as getStoredWorkspaceCommand,
  getSessionArtifactContent as getStoredSessionArtifactContent,
  getSessionCommandSessionId as getStoredSessionCommandSessionId,
  getSessionAttachmentContent as getStoredSessionAttachmentContent,
  getSession as getStoredSession,
  listQuickSkills as listStoredQuickSkills,
  listSessions as listStoredSessions,
  updateQuickSkill as updateStoredQuickSkill,
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

  const session = createStoredSession({
    projectId,
    prompt,
    attachments,
    runtime: input.runtime || {},
    mode: input.mode,
    sourceSessionId: input.sourceSessionId,
    threadMode: input.threadMode
  });
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

export function listCodexQuickSkills(options = {}) {
  return listStoredQuickSkills(options);
}

export function createCodexQuickSkill(input = {}) {
  return createStoredQuickSkill(input);
}

export function updateCodexQuickSkill(id, input = {}) {
  return updateStoredQuickSkill(id, input);
}

export function deleteCodexQuickSkill(id) {
  return deleteStoredQuickSkill(id);
}

export function getCodexSessionAttachmentContent(id) {
  return getStoredSessionAttachmentContent(id);
}

export function getCodexSessionArtifactContent(id) {
  return getStoredSessionArtifactContent(id);
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
  return waitForEventValue({
    eventNames: ["codex-workspace-command"],
    waitMs,
    getValue: () => acquireNextWorkspaceCommand({ agentId: agent.id })
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
  const acquire = () => {
    const command = acquireNextSessionCommand({
      agentId: agent.id,
      workspaces: agent.workspaces,
      busySessionIds: input.busySessionIds,
      busyProjectIds: input.busyProjectIds,
      runningSessionIds: input.runningSessionIds
    });
    if (command) notifySessionChanged(command.sessionId);
    return command;
  };
  const immediateCommand = acquire();
  if (immediateCommand) return immediateCommand;

  const waitMs = clampWaitMs(input.waitMs);
  return waitForEventValue({
    eventNames: ["codex-session-command"],
    waitMs,
    getValue: acquire
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
  return waitForEventValue({
    eventNames: [`codex-approval-${id}`, input.sessionId ? sessionChangedEventName(input.sessionId) : ""],
    waitMs,
    getValue: () => getStoredApprovalDecision(id, { agentId: input.agentId || input.agent?.id })
  });
}

export async function waitForCodexSessionInteraction(id, input = {}) {
  if (input.agent) updateCodexAgent(input.agent);
  else if (input.agentId) touchAgent(input.agentId);

  const immediateInteraction = getStoredInteractionDecision(id, { agentId: input.agentId || input.agent?.id });
  if (immediateInteraction) return immediateInteraction;

  const waitMs = clampWaitMs(input.waitMs);
  return waitForEventValue({
    eventNames: [`codex-interaction-${id}`, input.sessionId ? sessionChangedEventName(input.sessionId) : ""],
    waitMs,
    getValue: () => getStoredInteractionDecision(id, { agentId: input.agentId || input.agent?.id })
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

function waitForEventValue({ eventNames = [], waitMs, getValue }) {
  return new Promise((resolve) => {
    const names = eventNames.map((name) => String(name || "").trim()).filter(Boolean);
    let settled = false;
    let timeout = null;

    function cleanup() {
      for (const name of names) events.off(name, handleEvent);
      if (timeout) clearTimeout(timeout);
    }

    function finish(value) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value || null);
    }

    function handleEvent() {
      const value = getValue();
      if (value) finish(value);
    }

    for (const name of names) events.on(name, handleEvent);
    timeout = setTimeout(() => finish(null), waitMs);
    handleEvent();
  });
}

function sessionChangedEventName(id) {
  return `codex-session-changed-${id}`;
}

function clampWaitMs(value) {
  const waitMs = Number(value);
  if (!Number.isFinite(waitMs)) return 25000;
  return Math.max(1000, Math.min(waitMs, 30000));
}
