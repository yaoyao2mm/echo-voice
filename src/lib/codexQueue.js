import { EventEmitter } from "node:events";
import {
  acquireNextJob,
  appendEvents as appendStoredEvents,
  completeJob as completeStoredJob,
  createJob as createStoredJob,
  getJob as getStoredJob,
  listJobs as listStoredJobs,
  statusSnapshot,
  touchAgent,
  upsertAgent
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

export function listCodexJobs(limit = 20) {
  return listStoredJobs(limit);
}

export function getCodexJob(id) {
  return getStoredJob(id);
}

export async function waitForCodexJob(input = {}) {
  const agent = updateCodexAgent(input.agent || {});
  const immediateJob = acquireNextJob({ agentId: agent.id, workspaces: agent.workspaces });
  if (immediateJob) return buildAgentJob(immediateJob);

  const waitMs = Math.max(1000, Math.min(Number(input.waitMs || 25000), 30000));
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

export function appendCodexEvents(id, incomingEvents = [], options = {}) {
  if (options.agent) updateCodexAgent(options.agent);
  else if (options.agentId) touchAgent(options.agentId);
  return appendStoredEvents(id, incomingEvents, { agentId: options.agentId || options.agent?.id });
}

export function completeCodexJob(id, result = {}, options = {}) {
  if (options.agent) updateCodexAgent(options.agent);
  else if (options.agentId) touchAgent(options.agentId);
  const ok = completeStoredJob(id, result, { agentId: options.agentId || options.agent?.id });
  events.emit("codex-job");
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
