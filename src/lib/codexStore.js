import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const dbPath = path.join(config.dataDir, "echo.sqlite");
fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

migrate();

const insertJob = db.prepare(`
  INSERT INTO codex_jobs (
    id, project_id, prompt, status, created_at, updated_at
  ) VALUES (
    @id, @projectId, @prompt, 'queued', @now, @now
  )
`);

const insertEvent = db.prepare(`
  INSERT INTO codex_events (job_id, at, type, text, raw_json)
  VALUES (@jobId, @at, @type, @text, @rawJson)
`);

const trimEvents = db.prepare(`
  DELETE FROM codex_events
  WHERE job_id = ?
    AND id NOT IN (
      SELECT id FROM codex_events
      WHERE job_id = ?
      ORDER BY id DESC
      LIMIT ?
    )
`);

const summarizeJobColumns = `
  id,
  project_id AS projectId,
  prompt,
  status,
  created_at AS createdAt,
  started_at AS startedAt,
  completed_at AS completedAt,
  exit_code AS exitCode,
  error,
  final_message AS finalMessage,
  leased_by AS leasedBy,
  lease_expires_at AS leaseExpiresAt,
  updated_at AS updatedAt
`;

export function createJob({ projectId, prompt }) {
  const now = nowIso();
  const job = {
    id: crypto.randomUUID(),
    projectId,
    prompt,
    now
  };

  insertJob.run(job);
  trimOldJobs();
  return getJobSummary(job.id);
}

export function upsertAgent(input = {}) {
  const agentId = normalizeAgentId(input.id || input.agentId);
  const now = nowIso();
  const workspaces = normalizeWorkspaces(input.workspaces);
  const runtime = normalizeRuntime(input.runtime);

  db.prepare(`
    INSERT INTO codex_agents (
      id, last_seen_at, workspaces_json, runtime_json
    ) VALUES (
      @id, @now, @workspacesJson, @runtimeJson
    )
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      workspaces_json = excluded.workspaces_json,
      runtime_json = excluded.runtime_json
  `).run({
    id: agentId,
    now,
    workspacesJson: JSON.stringify(workspaces),
    runtimeJson: JSON.stringify(runtime)
  });

  return { id: agentId, lastSeenAt: now, workspaces, runtime };
}

export function touchAgent(id) {
  const agentId = normalizeAgentId(id);
  const now = nowIso();

  db.prepare(`
    INSERT INTO codex_agents (
      id, last_seen_at, workspaces_json, runtime_json
    ) VALUES (
      @id, @now, '[]', '{}'
    )
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at
  `).run({ id: agentId, now });

  return { id: agentId, lastSeenAt: now };
}

export function statusSnapshot() {
  reclaimExpiredLeases();

  const latestAgent = latestAgentSnapshot();
  const queued = db.prepare("SELECT COUNT(*) AS count FROM codex_jobs WHERE status = 'queued'").get().count;
  const running = db.prepare("SELECT COUNT(*) AS count FROM codex_jobs WHERE status = 'running'").get().count;
  const runningJobs = db.prepare(`
    SELECT ${summarizeJobColumns}
    FROM codex_jobs
    WHERE status = 'running'
    ORDER BY started_at DESC, created_at DESC
    LIMIT 10
  `).all().map(summarizeJob);

  return {
    enabled: true,
    agentOnline: Boolean(latestAgent && Date.now() - Date.parse(latestAgent.lastSeenAt) < 45000),
    lastAgentSeenAt: latestAgent?.lastSeenAt || "",
    agents: listAgents(),
    workspaces: latestAgent?.workspaces || [],
    runtime: latestAgent?.runtime || {},
    queued,
    running,
    active: runningJobs[0] || null,
    runningJobs,
    recent: listJobs(10)
  };
}

export function listJobs(limit = 20) {
  reclaimExpiredLeases();

  return db.prepare(`
    SELECT ${summarizeJobColumns}
    FROM codex_jobs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(Number(limit) || 20, 100))).map(summarizeJob);
}

export function getJob(id) {
  reclaimExpiredLeases();

  const row = db.prepare(`
    SELECT ${summarizeJobColumns}
    FROM codex_jobs
    WHERE id = ?
  `).get(id);
  if (!row) return null;

  return {
    ...summarizeJob(row),
    events: listEvents(id)
  };
}

export function acquireNextJob({ agentId, workspaces = [] } = {}) {
  reclaimExpiredLeases();

  const workspaceIds = workspaces.map((workspace) => workspace.id).filter(Boolean);
  if (workspaceIds.length === 0) return null;

  const leaseHolder = normalizeAgentId(agentId);
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const placeholders = workspaceIds.map(() => "?").join(",");

  const acquire = db.transaction(() => {
    const job = db.prepare(`
      SELECT ${summarizeJobColumns}
      FROM codex_jobs
      WHERE status = 'queued'
        AND project_id IN (${placeholders})
      ORDER BY created_at ASC
      LIMIT 1
    `).get(...workspaceIds);

    if (!job) return null;

    db.prepare(`
      UPDATE codex_jobs
      SET status = 'running',
          started_at = @now,
          completed_at = NULL,
          leased_by = @leasedBy,
          lease_expires_at = @leaseExpiresAt,
          updated_at = @now
      WHERE id = @id
        AND status = 'queued'
    `).run({
      id: job.id,
      now,
      leasedBy: leaseHolder,
      leaseExpiresAt
    });

    insertInternalEvents(job.id, [
      {
        type: "lease.acquired",
        text: `Desktop agent ${leaseHolder} acquired this Codex job.`
      }
    ]);

    return getJobSummary(job.id);
  });

  return acquire();
}

export function appendEvents(jobId, incomingEvents = [], options = {}) {
  const job = getJobSummary(jobId);
  if (!job) return false;

  const agentId = options.agentId ? normalizeAgentId(options.agentId) : "";
  if (agentId && job.leasedBy !== agentId) return false;

  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const events = incomingEvents.slice(0, 50).map((event) => normalizeEvent(jobId, event, now));

  const write = db.transaction(() => {
    for (const event of events) insertEvent.run(event);
    trimEvents.run(jobId, jobId, config.codex.maxEvents);

    if (job.status === "running") {
      db.prepare(`
        UPDATE codex_jobs
        SET lease_expires_at = @leaseExpiresAt,
            updated_at = @now
        WHERE id = @jobId
      `).run({ jobId, leaseExpiresAt, now });
    }
  });

  write();
  return true;
}

export function completeJob(jobId, result = {}, options = {}) {
  const job = getJobSummary(jobId);
  if (!job) return false;

  const agentId = options.agentId ? normalizeAgentId(options.agentId) : "";
  if (agentId && job.leasedBy !== agentId) return false;

  const now = nowIso();
  const status = result.ok === false ? "failed" : "completed";
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
  const error = String(result.error || "");
  const finalMessage = String(result.finalMessage || "").slice(0, 12000);

  const finish = db.transaction(() => {
    db.prepare(`
      UPDATE codex_jobs
      SET status = @status,
          completed_at = @now,
          exit_code = @exitCode,
          error = @error,
          final_message = @finalMessage,
          leased_by = NULL,
          lease_expires_at = NULL,
          updated_at = @now
      WHERE id = @jobId
    `).run({
      jobId,
      status,
      now,
      exitCode,
      error,
      finalMessage
    });

    insertInternalEvents(jobId, [
      {
        type: status === "completed" ? "job.completed" : "job.failed",
        text: status === "completed" ? "Codex job completed." : error || "Codex job failed."
      }
    ]);
  });

  finish();
  trimOldJobs();
  return true;
}

export function resetStoreForTest() {
  db.prepare("DELETE FROM codex_events").run();
  db.prepare("DELETE FROM codex_jobs").run();
  db.prepare("DELETE FROM codex_agents").run();
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'stale')),
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      exit_code INTEGER,
      error TEXT NOT NULL DEFAULT '',
      final_message TEXT NOT NULL DEFAULT '',
      leased_by TEXT,
      lease_expires_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_codex_jobs_status_created
      ON codex_jobs(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_jobs_lease
      ON codex_jobs(status, lease_expires_at);

    CREATE TABLE IF NOT EXISTS codex_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES codex_jobs(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_codex_events_job_id
      ON codex_events(job_id, id);

    CREATE TABLE IF NOT EXISTS codex_agents (
      id TEXT PRIMARY KEY,
      last_seen_at TEXT NOT NULL,
      workspaces_json TEXT NOT NULL DEFAULT '[]',
      runtime_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
}

function reclaimExpiredLeases() {
  const now = nowIso();
  const expired = db.prepare(`
    SELECT id, leased_by AS leasedBy
    FROM codex_jobs
    WHERE status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < ?
  `).all(now);

  if (expired.length === 0) return;

  const reclaim = db.transaction(() => {
    for (const job of expired) {
      db.prepare(`
        UPDATE codex_jobs
        SET status = 'queued',
            leased_by = NULL,
            lease_expires_at = NULL,
            updated_at = @now
        WHERE id = @id
          AND status = 'running'
      `).run({ id: job.id, now });

      insertInternalEvents(job.id, [
        {
          type: "lease.expired",
          text: `Desktop agent ${job.leasedBy || "unknown"} stopped renewing this job; it returned to the queue.`
        }
      ]);
    }
  });

  reclaim();
}

function latestAgentSnapshot() {
  const row = db.prepare(`
    SELECT id, last_seen_at AS lastSeenAt, workspaces_json AS workspacesJson, runtime_json AS runtimeJson
    FROM codex_agents
    ORDER BY last_seen_at DESC
    LIMIT 1
  `).get();
  return row ? parseAgent(row) : null;
}

function listAgents() {
  return db.prepare(`
    SELECT id, last_seen_at AS lastSeenAt, workspaces_json AS workspacesJson, runtime_json AS runtimeJson
    FROM codex_agents
    ORDER BY last_seen_at DESC
    LIMIT 10
  `).all().map(parseAgent);
}

function getJobSummary(id) {
  const row = db.prepare(`
    SELECT ${summarizeJobColumns}
    FROM codex_jobs
    WHERE id = ?
  `).get(id);
  return row ? summarizeJob(row) : null;
}

function summarizeJob(row) {
  const lastEvent = db.prepare(`
    SELECT at, type, text, raw_json AS rawJson
    FROM codex_events
    WHERE job_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(row.id);

  const eventCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_events
    WHERE job_id = ?
  `).get(row.id).count;

  return {
    ...row,
    eventCount,
    lastEvent: lastEvent ? parseEvent(lastEvent) : null
  };
}

function listEvents(jobId) {
  return db.prepare(`
    SELECT at, type, text, raw_json AS rawJson
    FROM codex_events
    WHERE job_id = ?
    ORDER BY id ASC
  `).all(jobId).map(parseEvent);
}

function insertInternalEvents(jobId, events) {
  const at = nowIso();
  for (const event of events) insertEvent.run(normalizeEvent(jobId, event, at));
  trimEvents.run(jobId, jobId, config.codex.maxEvents);
}

function normalizeEvent(jobId, event = {}, fallbackAt) {
  const raw = event.raw && typeof event.raw === "object" ? event.raw : undefined;
  return {
    jobId,
    at: String(event.at || fallbackAt || nowIso()),
    type: String(event.type || "output").slice(0, 120),
    text: String(event.text || "").slice(0, 8000),
    rawJson: raw ? JSON.stringify(raw).slice(0, 20000) : null
  };
}

function parseEvent(row) {
  return {
    at: row.at,
    type: row.type,
    text: row.text,
    raw: parseJson(row.rawJson)
  };
}

function parseAgent(row) {
  return {
    id: row.id,
    lastSeenAt: row.lastSeenAt,
    workspaces: parseJson(row.workspacesJson, []),
    runtime: parseJson(row.runtimeJson, {})
  };
}

function parseJson(value, fallback = undefined) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeAgentId(value) {
  return String(value || "default-agent").trim().slice(0, 120) || "default-agent";
}

function normalizeWorkspaces(workspaces = []) {
  return Array.isArray(workspaces)
    ? workspaces
        .map((workspace) => ({
          id: String(workspace.id || "").trim(),
          label: String(workspace.label || workspace.id || "").trim(),
          path: String(workspace.path || "").trim()
        }))
        .filter((workspace) => workspace.id && workspace.path)
    : [];
}

function normalizeRuntime(runtime = {}) {
  return runtime && typeof runtime === "object"
    ? {
        command: String(runtime.command || "").trim(),
        sandbox: String(runtime.sandbox || "").trim(),
        model: String(runtime.model || "").trim(),
        profile: String(runtime.profile || "").trim(),
        timeoutMs: Number(runtime.timeoutMs || 0) || null
      }
    : {};
}

function trimOldJobs() {
  const ids = db.prepare(`
    SELECT id
    FROM codex_jobs
    WHERE status IN ('completed', 'failed', 'cancelled', 'stale')
      AND id NOT IN (
        SELECT id
        FROM codex_jobs
        ORDER BY created_at DESC
        LIMIT 100
      )
  `).all().map((row) => row.id);

  if (ids.length === 0) return;

  const remove = db.prepare("DELETE FROM codex_jobs WHERE id = ?");
  const removeMany = db.transaction((jobIds) => {
    for (const id of jobIds) remove.run(id);
  });
  removeMany(ids);
}

function nowIso() {
  return new Date().toISOString();
}
