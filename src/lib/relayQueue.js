import { EventEmitter } from "node:events";
import crypto from "node:crypto";

const events = new EventEmitter();
const queuedJobs = [];
const completedJobs = [];
let activeJob = null;
let lastDesktopSeenAt = "";

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
    createdAt: new Date().toISOString()
  };

  queuedJobs.push(job);
  events.emit("job");
  return job;
}

export async function waitForInsertJob(waitMs = 25000) {
  markDesktopSeen();
  reclaimStaleActiveJob();

  if (queuedJobs.length > 0 && !activeJob) {
    activeJob = queuedJobs.shift();
    activeJob.deliveredAt = new Date().toISOString();
    return activeJob;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      events.off("job", handleJob);
      resolve(null);
    }, Math.max(1000, Math.min(waitMs, 30000)));

    function handleJob() {
      if (activeJob || queuedJobs.length === 0) return;
      clearTimeout(timeout);
      events.off("job", handleJob);
      activeJob = queuedJobs.shift();
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

  queuedJobs.unshift({
    id: activeJob.id,
    text: activeJob.text,
    createdAt: activeJob.createdAt,
    lastError: errorMessage,
    retryAt: new Date().toISOString()
  });
  activeJob = null;
  events.emit("job");
  return true;
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
    lastError: "Desktop agent did not acknowledge the job in time.",
    retryAt: new Date().toISOString()
  });
  activeJob = null;
}
