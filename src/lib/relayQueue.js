import { EventEmitter } from "node:events";
import crypto from "node:crypto";

const events = new EventEmitter();
const queuedJobs = [];
const completedJobs = [];
let activeJob = null;
let lastDesktopSeenAt = "";
const maxAttempts = 3;

export function relayStatus() {
  return {
    queued: queuedJobs.length,
    active: Boolean(activeJob),
    completed: completedJobs.length,
    desktopOnline: isDesktopOnline(),
    lastDesktopSeenAt
  };
}

export function markDesktopSeen() {
  lastDesktopSeenAt = new Date().toISOString();
}

export function enqueueInsertJob(text) {
  const value = String(text || "");
  if (!value.trim()) {
    const error = new Error("Cannot insert empty text.");
    error.statusCode = 400;
    throw error;
  }

  const job = {
    id: crypto.randomUUID(),
    text: value,
    createdAt: new Date().toISOString(),
    attempts: 0
  };

  queuedJobs.push(job);
  events.emit("job");
  return job;
}

export async function waitForInsertJob(waitMs = 25000) {
  markDesktopSeen();
  reclaimStaleActiveJob();

  const readyIndex = nextReadyJobIndex();
  if (readyIndex >= 0 && !activeJob) {
    activeJob = queuedJobs.splice(readyIndex, 1)[0];
    activeJob.deliveredAt = new Date().toISOString();
    return activeJob;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      events.off("job", handleJob);
      resolve(null);
    }, Math.max(1000, Math.min(waitMs, 30000)));

    function handleJob() {
      const index = nextReadyJobIndex();
      if (activeJob || index < 0) return;
      clearTimeout(timeout);
      events.off("job", handleJob);
      activeJob = queuedJobs.splice(index, 1)[0];
      activeJob.deliveredAt = new Date().toISOString();
      resolve(activeJob);
    }

    events.on("job", handleJob);
  });
}

export function ackInsertJob(id, result = {}) {
  markDesktopSeen();

  if (!activeJob || activeJob.id !== id) {
    return false;
  }

  completedJobs.unshift({
    ...activeJob,
    completedAt: new Date().toISOString(),
    result
  });
  completedJobs.splice(50);
  activeJob = null;

  if (queuedJobs.length > 0) events.emit("job");
  return true;
}

export function failInsertJob(id, errorMessage) {
  markDesktopSeen();

  if (!activeJob || activeJob.id !== id) {
    return false;
  }

  const attempts = (activeJob.attempts || 0) + 1;
  if (attempts >= maxAttempts) {
    completedJobs.unshift({
      ...activeJob,
      attempts,
      failedAt: new Date().toISOString(),
      error: errorMessage
    });
    completedJobs.splice(50);
    activeJob = null;
    if (queuedJobs.length > 0) events.emit("job");
    return true;
  }

  const retryAt = new Date(Date.now() + attempts * 3000).toISOString();
  queuedJobs.unshift({
    id: activeJob.id,
    text: activeJob.text,
    createdAt: activeJob.createdAt,
    attempts,
    lastError: errorMessage,
    retryAt
  });
  activeJob = null;
  setTimeout(() => events.emit("job"), attempts * 3000);
  return true;
}

function nextReadyJobIndex() {
  const now = Date.now();
  return queuedJobs.findIndex((job) => !job.retryAt || Date.parse(job.retryAt) <= now);
}

function isDesktopOnline() {
  if (!lastDesktopSeenAt) return false;
  return Date.now() - Date.parse(lastDesktopSeenAt) < 45000;
}

function reclaimStaleActiveJob() {
  if (!activeJob?.deliveredAt) return;
  if (Date.now() - Date.parse(activeJob.deliveredAt) < 60000) return;

  queuedJobs.unshift({
    id: activeJob.id,
    text: activeJob.text,
    createdAt: activeJob.createdAt,
    attempts: activeJob.attempts || 0,
    lastError: "Desktop agent did not acknowledge the job in time.",
    retryAt: new Date().toISOString()
  });
  activeJob = null;
}
