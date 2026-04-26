import { EventEmitter } from "node:events";
import crypto from "node:crypto";

const events = new EventEmitter();
const queuedJobs = [];
const jobs = [];
let activeJob = null;
let lastAgentSeenAt = "";
let agentWorkspaces = [];

export function updateCodexAgent(input = {}) {
  lastAgentSeenAt = new Date().toISOString();
  if (Array.isArray(input.workspaces)) {
    agentWorkspaces = input.workspaces
      .map((workspace) => ({
        id: String(workspace.id || "").trim(),
        label: String(workspace.label || workspace.id || "").trim(),
        path: String(workspace.path || "").trim()
      }))
      .filter((workspace) => workspace.id && workspace.path);
  }
}

export function codexStatus() {
  return {
    enabled: true,
    agentOnline: isAgentOnline(),
    lastAgentSeenAt,
    workspaces: agentWorkspaces.map((workspace) => ({
      id: workspace.id,
      label: workspace.label,
      path: workspace.path
    })),
    queued: queuedJobs.length,
    active: activeJob ? summarizeJob(activeJob) : null,
    recent: jobs.slice(0, 10).map(summarizeJob)
  };
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

  const job = {
    id: crypto.randomUUID(),
    projectId,
    prompt,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: "",
    completedAt: "",
    exitCode: null,
    error: "",
    finalMessage: "",
    events: []
  };

  queuedJobs.push(job);
  jobs.unshift(job);
  jobs.splice(100);
  events.emit("codex-job");
  return summarizeJob(job);
}

export function listCodexJobs(limit = 20) {
  return jobs.slice(0, limit).map(summarizeJob);
}

export function getCodexJob(id) {
  return jobs.find((job) => job.id === id) || null;
}

export async function waitForCodexJob(input = {}) {
  updateCodexAgent(input.agent || {});

  if (queuedJobs.length > 0 && !activeJob) {
    activeJob = queuedJobs.shift();
    activeJob.status = "running";
    activeJob.startedAt = new Date().toISOString();
    return buildAgentJob(activeJob);
  }

  const waitMs = Math.max(1000, Math.min(Number(input.waitMs || 25000), 30000));
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      events.off("codex-job", handleJob);
      resolve(null);
    }, waitMs);

    function handleJob() {
      if (activeJob || queuedJobs.length === 0) return;
      clearTimeout(timeout);
      events.off("codex-job", handleJob);
      activeJob = queuedJobs.shift();
      activeJob.status = "running";
      activeJob.startedAt = new Date().toISOString();
      resolve(buildAgentJob(activeJob));
    }

    events.on("codex-job", handleJob);
  });
}

export function appendCodexEvents(id, incomingEvents = []) {
  updateCodexAgent();
  const job = getCodexJob(id);
  if (!job) return false;

  for (const event of incomingEvents.slice(0, 50)) {
    job.events.push({
      at: new Date().toISOString(),
      type: String(event.type || "output"),
      text: String(event.text || "").slice(0, 8000),
      raw: event.raw && typeof event.raw === "object" ? event.raw : undefined
    });
  }

  if (job.events.length > 500) {
    job.events.splice(0, job.events.length - 500);
  }

  return true;
}

export function completeCodexJob(id, result = {}) {
  updateCodexAgent();
  const job = getCodexJob(id);
  if (!job) return false;

  job.status = result.ok === false ? "failed" : "completed";
  job.completedAt = new Date().toISOString();
  job.exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
  job.error = String(result.error || "");
  job.finalMessage = String(result.finalMessage || "").slice(0, 12000);

  if (activeJob?.id === id) {
    activeJob = null;
    if (queuedJobs.length > 0) events.emit("codex-job");
  }

  return true;
}

function buildAgentJob(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    prompt: job.prompt,
    createdAt: job.createdAt
  };
}

function summarizeJob(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    prompt: job.prompt,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    exitCode: job.exitCode,
    error: job.error,
    finalMessage: job.finalMessage,
    eventCount: job.events.length,
    lastEvent: job.events.at(-1) || null
  };
}

function isAgentOnline() {
  if (!lastAgentSeenAt) return false;
  return Date.now() - Date.parse(lastAgentSeenAt) < 45000;
}
