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

const insertSessionEvent = db.prepare(`
  INSERT INTO codex_session_events (session_id, at, type, text, raw_json)
  VALUES (@sessionId, @at, @type, @text, @rawJson)
`);

const insertSessionCommand = db.prepare(`
  INSERT INTO codex_session_commands (
    id, session_id, type, payload_json, status, created_at, updated_at
  ) VALUES (
    @id, @sessionId, @type, @payloadJson, 'queued', @now, @now
  )
`);

const insertSessionApproval = db.prepare(`
  INSERT INTO codex_session_approvals (
    id, session_id, app_request_id, method, status, prompt, payload_json, response_json, created_at, updated_at, requested_by
  ) VALUES (
    @id, @sessionId, @appRequestId, @method, 'pending', @prompt, @payloadJson, '', @now, @now, @requestedBy
  )
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

const trimSessionEvents = db.prepare(`
  DELETE FROM codex_session_events
  WHERE session_id = ?
    AND id NOT IN (
      SELECT id FROM codex_session_events
      WHERE session_id = ?
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

const summarizeSessionColumns = `
  id,
  project_id AS projectId,
  title,
  status,
  app_thread_id AS appThreadId,
  active_turn_id AS activeTurnId,
  created_at AS createdAt,
  updated_at AS updatedAt,
  last_error AS lastError,
  final_message AS finalMessage,
  leased_by AS leasedBy,
  lease_expires_at AS leaseExpiresAt,
  archived_at AS archivedAt,
  runtime_json AS runtimeJson
`;

const summarizeSessionCommandColumns = `
  id,
  session_id AS sessionId,
  type,
  payload_json AS payloadJson,
  status,
  created_at AS createdAt,
  updated_at AS updatedAt,
  leased_by AS leasedBy,
  lease_expires_at AS leaseExpiresAt,
  error
`;

const summarizeSessionApprovalColumns = `
  id,
  session_id AS sessionId,
  app_request_id AS appRequestId,
  method,
  status,
  prompt,
  payload_json AS payloadJson,
  response_json AS responseJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  decided_at AS decidedAt,
  decided_by AS decidedBy,
  requested_by AS requestedBy
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

  const nowMs = Date.now();
  const agents = listAgents().map((agent) => ({
    ...agent,
    online: isAgentOnline(agent, nowMs)
  }));
  const onlineAgents = agents.filter((agent) => agent.online);
  const latestAgent = agents[0] || null;
  const primaryAgent = onlineAgents[0] || null;
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
    agentOnline: onlineAgents.length > 0,
    lastAgentSeenAt: latestAgent?.lastSeenAt || "",
    agents,
    workspaces: mergeAgentWorkspaces(onlineAgents),
    runtime: primaryAgent?.runtime || {},
    queued,
    running,
    active: runningJobs[0] || null,
    runningJobs,
    recent: listJobs(10),
    interactive: sessionStatusSnapshot()
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

  if (!canMutateRunningJob(job, options.agentId)) return false;

  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const events = incomingEvents.slice(0, 50).map((event) => normalizeEvent(jobId, event, now));

  const write = db.transaction(() => {
    const update = db.prepare(`
      UPDATE codex_jobs
      SET lease_expires_at = @leaseExpiresAt,
          updated_at = @now
      WHERE id = @jobId
        AND status = 'running'
        AND leased_by = @leasedBy
    `).run({ jobId, leaseExpiresAt, now, leasedBy: job.leasedBy });

    if (update.changes === 0) return false;

    for (const event of events) insertEvent.run(event);
    trimEvents.run(jobId, jobId, config.codex.maxEvents);
    return true;
  });

  return write();
}

export function completeJob(jobId, result = {}, options = {}) {
  const job = getJobSummary(jobId);
  if (!job) return false;

  if (!canMutateRunningJob(job, options.agentId)) return false;

  const now = nowIso();
  const error = String(result.error || "");
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
  const succeeded = result.ok === true && !error && (exitCode === null || exitCode === 0);
  const status = succeeded ? "completed" : "failed";
  const finalMessage = String(result.finalMessage || "").slice(0, 12000);

  const finish = db.transaction(() => {
    const update = db.prepare(`
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
        AND status = 'running'
        AND leased_by = @leasedBy
    `).run({
      jobId,
      status,
      now,
      exitCode,
      error,
      finalMessage,
      leasedBy: job.leasedBy
    });

    if (update.changes === 0) return false;

    insertInternalEvents(jobId, [
      {
        type: status === "completed" ? "job.completed" : "job.failed",
        text: status === "completed" ? "Codex job completed." : error || "Codex job failed."
      }
    ]);
    return true;
  });

  if (!finish()) return false;
  trimOldJobs();
  return true;
}

export function createSession({ projectId, prompt, runtime }) {
  const now = nowIso();
  const sessionId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const normalizedPrompt = String(prompt || "").trim();
  const normalizedProjectId = String(projectId || "").trim();
  const normalizedRuntime = normalizeRuntime(runtime);
  const title = normalizedPrompt.split(/\s+/).join(" ").slice(0, 120) || "Codex session";

  const create = db.transaction(() => {
    db.prepare(`
      INSERT INTO codex_sessions (
        id, project_id, title, status, created_at, updated_at, runtime_json
      ) VALUES (
        @id, @projectId, @title, 'queued', @now, @now, @runtimeJson
      )
    `).run({
      id: sessionId,
      projectId: normalizedProjectId,
      title,
      now,
      runtimeJson: JSON.stringify(normalizedRuntime)
    });

    insertSessionCommand.run({
      id: commandId,
      sessionId,
      type: "start",
      payloadJson: JSON.stringify({ prompt: normalizedPrompt }),
      now
    });

    insertSessionEvent.run(
      normalizeSessionEvent(sessionId, {
        type: "user.message",
        text: normalizedPrompt,
        raw: { source: "mobile", commandId, type: "start" }
      }, now)
    );
  });

  create();
  trimOldSessions();
  return getSessionSummary(sessionId);
}

export function listSessions(limit = 20, options = {}) {
  reclaimExpiredSessionCommandLeases();
  const archived = Boolean(options.archived);

  return db.prepare(`
    SELECT ${summarizeSessionColumns}
    FROM codex_sessions
    WHERE archived_at ${archived ? "IS NOT NULL" : "IS NULL"}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(Number(limit) || 20, 100))).map(summarizeSession);
}

export function getSession(id) {
  reclaimExpiredSessionCommandLeases();

  const session = getSessionSummary(id);
  if (!session) return null;
  return {
    ...session,
    events: listSessionEvents(id),
    approvals: listSessionApprovals(id)
  };
}

export function archiveSession(id, input = {}) {
  const session = getSessionSummary(id);
  if (!session) return notFound("Codex session not found.");

  const archive = input.archived !== false;
  if (
    archive &&
    (["queued", "starting", "running"].includes(session.status) ||
      session.pendingCommandCount > 0 ||
      session.pendingApprovalCount > 0)
  ) {
    return conflict("Running Codex sessions cannot be archived yet.");
  }

  const now = nowIso();
  db.prepare(`
    UPDATE codex_sessions
    SET archived_at = @archivedAt,
        updated_at = @now
    WHERE id = @id
  `).run({
    id,
    archivedAt: archive ? now : null,
    now
  });

  insertSessionEvent.run(
    normalizeSessionEvent(id, {
      type: archive ? "session.archived" : "session.restored",
      text: archive ? "Session archived." : "Session restored."
    }, now)
  );

  return getSessionSummary(id);
}

export function enqueueSessionMessage(sessionId, input = {}) {
  const session = getSessionSummary(sessionId);
  if (!session) return notFound("Codex session not found.");
  if (session.archivedAt) return conflict("Restore this Codex session before continuing it.");
  if (["closed", "failed", "stale"].includes(session.status)) {
    return conflict("This Codex session is no longer active.");
  }

  const now = nowIso();
  const commandId = crypto.randomUUID();
  const message = String(input.text || input.prompt || "").trim();
  const runtime = normalizeRuntime(Object.keys(input.runtime || {}).length > 0 ? input.runtime : session.runtime);
  if (!message) return badRequest("Codex message is required.");

  const enqueue = db.transaction(() => {
    insertSessionCommand.run({
      id: commandId,
      sessionId,
      type: "message",
      payloadJson: JSON.stringify({ text: message }),
      now
    });

    db.prepare(`
      UPDATE codex_sessions
      SET updated_at = @now,
          runtime_json = @runtimeJson,
          status = CASE WHEN status = 'queued' THEN 'queued' ELSE status END
      WHERE id = @sessionId
    `).run({ sessionId, now, runtimeJson: JSON.stringify(runtime) });

    insertSessionEvent.run(
      normalizeSessionEvent(sessionId, {
        type: "user.message",
        text: message,
        raw: { source: "mobile", commandId, type: "message" }
      }, now)
    );
  });

  enqueue();
  return getSession(sessionId);
}

export function acquireNextSessionCommand({ agentId, workspaces = [] } = {}) {
  reclaimExpiredSessionCommandLeases();

  const workspaceIds = workspaces.map((workspace) => workspace.id).filter(Boolean);
  if (workspaceIds.length === 0) return null;

  const leaseHolder = normalizeAgentId(agentId);
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const placeholders = workspaceIds.map(() => "?").join(",");

  const acquire = db.transaction(() => {
    const command = db.prepare(`
      SELECT
        c.id,
        c.session_id AS sessionId,
        c.type,
        c.payload_json AS payloadJson,
        c.status,
        c.created_at AS createdAt,
        c.updated_at AS updatedAt,
        c.leased_by AS leasedBy,
        c.lease_expires_at AS leaseExpiresAt,
        c.error,
        s.project_id AS projectId,
        s.app_thread_id AS appThreadId,
        s.active_turn_id AS activeTurnId,
        s.runtime_json AS runtimeJson
      FROM codex_session_commands c
      JOIN codex_sessions s ON s.id = c.session_id
      WHERE c.status = 'queued'
        AND s.status NOT IN ('closed', 'failed', 'stale')
        AND s.project_id IN (${placeholders})
      ORDER BY c.created_at ASC
      LIMIT 1
    `).get(...workspaceIds);

    if (!command) return null;

    db.prepare(`
      UPDATE codex_session_commands
      SET status = 'leased',
          leased_by = @leasedBy,
          lease_expires_at = @leaseExpiresAt,
          updated_at = @now
      WHERE id = @id
        AND status = 'queued'
    `).run({
      id: command.id,
      leasedBy: leaseHolder,
      leaseExpiresAt,
      now
    });

    db.prepare(`
      UPDATE codex_sessions
      SET status = @status,
          leased_by = @leasedBy,
          lease_expires_at = @leaseExpiresAt,
          updated_at = @now
      WHERE id = @sessionId
    `).run({
      sessionId: command.sessionId,
      status: command.type === "start" ? "starting" : "running",
      leasedBy: leaseHolder,
      leaseExpiresAt,
      now
    });

    insertSessionEvent.run(
      normalizeSessionEvent(command.sessionId, {
        type: "command.acquired",
        text: `Desktop agent ${leaseHolder} acquired ${command.type}.`
      }, now)
    );

    return buildAgentSessionCommand(command);
  });

  return acquire();
}

export function appendSessionEvents(sessionId, incomingEvents = [], options = {}) {
  const session = getSessionSummary(sessionId);
  if (!session) return false;
  if (!canMutateSession(session, options.agentId)) return false;

  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const events = incomingEvents.slice(0, 80).map((event) => normalizeSessionEvent(sessionId, event, now));
  const update = deriveSessionUpdate(incomingEvents, session);

  const write = db.transaction(() => {
    db.prepare(`
      UPDATE codex_sessions
      SET lease_expires_at = @leaseExpiresAt,
          updated_at = @now,
          status = COALESCE(@status, status),
          app_thread_id = COALESCE(@appThreadId, app_thread_id),
          active_turn_id = CASE WHEN @clearActiveTurnId = 1 THEN NULL ELSE COALESCE(@activeTurnId, active_turn_id) END,
          last_error = COALESCE(@lastError, last_error),
          final_message = COALESCE(@finalMessage, final_message)
      WHERE id = @sessionId
        AND leased_by = @leasedBy
    `).run({
      sessionId,
      now,
      leaseExpiresAt,
      leasedBy: session.leasedBy,
      status: update.status,
      appThreadId: update.appThreadId,
      activeTurnId: update.activeTurnId,
      clearActiveTurnId: update.clearActiveTurnId ? 1 : 0,
      lastError: update.lastError,
      finalMessage: update.finalMessage
    });

    for (const event of events) insertSessionEvent.run(event);
    trimSessionEvents.run(sessionId, sessionId, config.codex.maxEvents);
    return true;
  });

  return write();
}

export function completeSessionCommand(commandId, result = {}, options = {}) {
  const command = getSessionCommandSummary(commandId);
  if (!command) return false;
  const providedAgentId = normalizeAgentId(options.agentId);
  if (command.status !== "leased" || command.leasedBy !== providedAgentId) return false;

  const session = getSessionSummary(command.sessionId);
  if (!session || !canMutateSession(session, providedAgentId)) return false;

  const now = nowIso();
  const ok = result.ok === true;
  const error = String(result.error || "");
  const status = ok ? "done" : "failed";
  const resultSessionStatus = ok ? result.sessionStatus || (result.activeTurnId ? "running" : "active") : "failed";
  const turnAlreadyCompleted = ok && resultSessionStatus === "running" && getLatestSessionEventType(command.sessionId) === "turn/completed";
  const sessionStatus = turnAlreadyCompleted ? "active" : resultSessionStatus;
  const activeTurnId = turnAlreadyCompleted ? null : result.activeTurnId || null;

  const complete = db.transaction(() => {
    db.prepare(`
      UPDATE codex_session_commands
      SET status = @status,
          error = @error,
          updated_at = @now,
          leased_by = NULL,
          lease_expires_at = NULL
      WHERE id = @commandId
        AND status = 'leased'
        AND leased_by = @leasedBy
    `).run({
      commandId,
      status,
      error,
      now,
      leasedBy: providedAgentId
    });

    db.prepare(`
      UPDATE codex_sessions
      SET status = @sessionStatus,
          app_thread_id = COALESCE(@appThreadId, app_thread_id),
          active_turn_id = COALESCE(@activeTurnId, active_turn_id),
          last_error = @lastError,
          final_message = COALESCE(@finalMessage, final_message),
          updated_at = @now
      WHERE id = @sessionId
        AND leased_by = @leasedBy
    `).run({
      sessionId: command.sessionId,
      sessionStatus,
      appThreadId: result.appThreadId || null,
      activeTurnId,
      lastError: error,
      finalMessage: result.finalMessage || null,
      now,
      leasedBy: providedAgentId
    });

    insertSessionEvent.run(
      normalizeSessionEvent(command.sessionId, {
        type: ok ? "command.completed" : "command.failed",
        text: ok ? `${command.type} accepted by Codex app-server.` : error || `${command.type} failed.`
      }, now)
    );
  });

  complete();
  trimOldSessions();
  return true;
}

export function createSessionApproval(input = {}, options = {}) {
  const session = getSessionSummary(input.sessionId);
  if (!session) return notFound("Codex session not found.");
  if (!canMutateSession(session, options.agentId)) return false;

  const now = nowIso();
  const approval = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    appRequestId: String(input.appRequestId || ""),
    method: String(input.method || ""),
    prompt: String(input.prompt || "").slice(0, 12000),
    payloadJson: JSON.stringify(input.payload || {}).slice(0, 30000),
    requestedBy: normalizeAgentId(options.agentId),
    now
  };

  const create = db.transaction(() => {
    const existing = db.prepare(`
      SELECT ${summarizeSessionApprovalColumns}
      FROM codex_session_approvals
      WHERE session_id = ?
        AND app_request_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(approval.sessionId, approval.appRequestId);

    if (existing) return summarizeSessionApproval(existing);

    insertSessionApproval.run(approval);

    insertSessionEvent.run(
      normalizeSessionEvent(approval.sessionId, {
        type: "approval.requested",
        text: approval.prompt || `${approval.method} approval requested.`,
        raw: {
          approvalId: approval.id,
          appRequestId: approval.appRequestId,
          method: approval.method,
          payload: input.payload || {}
        }
      }, now)
    );

    return getSessionApprovalSummary(approval.id);
  });

  return create();
}

export function decideSessionApproval(id, input = {}, options = {}) {
  const approval = getSessionApprovalSummary(id);
  if (!approval) return notFound("Codex approval not found.");
  if (input.sessionId && approval.sessionId !== input.sessionId) return notFound("Codex approval not found.");
  if (approval.status !== "pending") return approval;

  const now = nowIso();
  const status = normalizeApprovalStatus(input.decision);
  const response = buildApprovalResponse(approval.method, status);
  const decidedBy = String(options.user?.username || options.user?.displayName || "mobile").slice(0, 120);

  const decide = db.transaction(() => {
    db.prepare(`
      UPDATE codex_session_approvals
      SET status = @status,
          response_json = @responseJson,
          decided_at = @now,
          decided_by = @decidedBy,
          updated_at = @now
      WHERE id = @id
        AND status = 'pending'
    `).run({
      id,
      status,
      responseJson: JSON.stringify(response),
      now,
      decidedBy
    });

    insertSessionEvent.run(
      normalizeSessionEvent(approval.sessionId, {
        type: status === "approved" ? "approval.approved" : "approval.denied",
        text: `${approval.method} ${status}.`,
        raw: { approvalId: approval.id, response }
      }, now)
    );

    return getSessionApprovalSummary(id);
  });

  return decide();
}

export function waitForSessionApprovalDecision(id, options = {}) {
  expireOldApprovals();
  const approval = getSessionApprovalSummary(id);
  if (!approval) return null;
  if (options.agentId && approval.requestedBy !== normalizeAgentId(options.agentId)) return null;
  return approval.status === "pending" ? null : approval;
}

export function resetStoreForTest() {
  db.prepare("DELETE FROM codex_session_approvals").run();
  db.prepare("DELETE FROM codex_session_events").run();
  db.prepare("DELETE FROM codex_session_commands").run();
  db.prepare("DELETE FROM codex_sessions").run();
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

    CREATE TABLE IF NOT EXISTS codex_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'active', 'running', 'failed', 'closed', 'stale')),
      app_thread_id TEXT,
      active_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      final_message TEXT NOT NULL DEFAULT '',
      leased_by TEXT,
      lease_expires_at TEXT,
      runtime_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_status_updated
      ON codex_sessions(status, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_thread
      ON codex_sessions(app_thread_id);

    CREATE TABLE IF NOT EXISTS codex_session_commands (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('start', 'message', 'stop')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      leased_by TEXT,
      lease_expires_at TEXT,
      error TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_commands_status_created
      ON codex_session_commands(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_commands_session
      ON codex_session_commands(session_id, created_at);

    CREATE TABLE IF NOT EXISTS codex_session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_events_session_id
      ON codex_session_events(session_id, id);

    CREATE TABLE IF NOT EXISTS codex_session_approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      app_request_id TEXT NOT NULL,
      method TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'timed_out')),
      prompt TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      response_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT NOT NULL DEFAULT '',
      requested_by TEXT NOT NULL DEFAULT '',
      UNIQUE(session_id, app_request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_approvals_session
      ON codex_session_approvals(session_id, status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_approvals_status
      ON codex_session_approvals(status, created_at);
  `);

  ensureColumn("codex_sessions", "archived_at", "TEXT");
  ensureColumn("codex_sessions", "runtime_json", "TEXT NOT NULL DEFAULT '{}'");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_codex_sessions_archived_updated
      ON codex_sessions(archived_at, updated_at);
  `);
}

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((info) => info.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

function listAgents() {
  return db.prepare(`
    SELECT id, last_seen_at AS lastSeenAt, workspaces_json AS workspacesJson, runtime_json AS runtimeJson
    FROM codex_agents
    ORDER BY last_seen_at DESC
    LIMIT 10
  `).all().map(parseAgent);
}

function isAgentOnline(agent, nowMs = Date.now()) {
  const lastSeenMs = Date.parse(agent?.lastSeenAt || "");
  return Number.isFinite(lastSeenMs) && nowMs - lastSeenMs < 45000;
}

function mergeAgentWorkspaces(agents) {
  const byId = new Map();
  for (const agent of agents) {
    for (const workspace of agent.workspaces || []) {
      if (!byId.has(workspace.id)) {
        byId.set(workspace.id, {
          ...workspace,
          agentId: agent.id,
          agentLastSeenAt: agent.lastSeenAt
        });
      }
    }
  }
  return Array.from(byId.values());
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

function sessionStatusSnapshot() {
  reclaimExpiredSessionCommandLeases();
  expireOldApprovals();

  const queuedCommands = db.prepare("SELECT COUNT(*) AS count FROM codex_session_commands WHERE status = 'queued'").get().count;
  const activeSessions = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_sessions
    WHERE status IN ('starting', 'active', 'running')
      AND archived_at IS NULL
  `).get().count;
  const pendingApprovals = db.prepare("SELECT COUNT(*) AS count FROM codex_session_approvals WHERE status = 'pending'").get().count;
  const archivedSessions = db.prepare("SELECT COUNT(*) AS count FROM codex_sessions WHERE archived_at IS NOT NULL").get().count;

  return {
    queuedCommands,
    activeSessions,
    pendingApprovals,
    archivedSessions,
    recent: listSessions(8)
  };
}

function getSessionSummary(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionColumns}
    FROM codex_sessions
    WHERE id = ?
  `).get(id);
  return row ? summarizeSession(row) : null;
}

function getSessionCommandSummary(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionCommandColumns}
    FROM codex_session_commands
    WHERE id = ?
  `).get(id);
  return row ? summarizeSessionCommand(row) : null;
}

function summarizeSession(row) {
  const lastEvent = db.prepare(`
    SELECT at, type, text, raw_json AS rawJson
    FROM codex_session_events
    WHERE session_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(row.id);

  const eventCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_events
    WHERE session_id = ?
  `).get(row.id).count;

  const pendingCommandCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_commands
    WHERE session_id = ?
      AND status IN ('queued', 'leased')
  `).get(row.id).count;
  const pendingApprovalCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_approvals
    WHERE session_id = ?
      AND status = 'pending'
  `).get(row.id).count;

  return {
    ...row,
    runtime: parseJson(row.runtimeJson, {}),
    eventCount,
    pendingCommandCount,
    pendingApprovalCount,
    lastEvent: lastEvent ? parseEvent(lastEvent) : null
  };
}

function summarizeSessionCommand(row) {
  return {
    ...row,
    payload: parseJson(row.payloadJson, {})
  };
}

function getSessionApprovalSummary(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionApprovalColumns}
    FROM codex_session_approvals
    WHERE id = ?
  `).get(id);
  return row ? summarizeSessionApproval(row) : null;
}

function summarizeSessionApproval(row) {
  return {
    ...row,
    payload: parseJson(row.payloadJson, {}),
    response: parseJson(row.responseJson, null)
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

function listSessionEvents(sessionId) {
  return db.prepare(`
    SELECT at, type, text, raw_json AS rawJson
    FROM codex_session_events
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(sessionId).map(parseEvent);
}

function listSessionApprovals(sessionId) {
  return db.prepare(`
    SELECT ${summarizeSessionApprovalColumns}
    FROM codex_session_approvals
    WHERE session_id = ?
      AND status = 'pending'
    ORDER BY created_at ASC
  `).all(sessionId).map(summarizeSessionApproval);
}

function getLatestSessionEventType(sessionId) {
  return db.prepare(`
    SELECT type
    FROM codex_session_events
    WHERE session_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(sessionId)?.type || "";
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

function normalizeSessionEvent(sessionId, event = {}, fallbackAt) {
  const raw = event.raw && typeof event.raw === "object" ? event.raw : undefined;
  return {
    sessionId,
    at: String(event.at || fallbackAt || nowIso()),
    type: String(event.type || "output").slice(0, 120),
    text: String(event.text || "").slice(0, 12000),
    rawJson: raw ? JSON.stringify(raw).slice(0, 30000) : null
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

function buildAgentSessionCommand(command) {
  const parsed = summarizeSessionCommand(command);
  return {
    id: parsed.id,
    sessionId: parsed.sessionId,
    type: parsed.type,
    projectId: command.projectId,
    appThreadId: command.appThreadId || "",
    activeTurnId: command.activeTurnId || "",
    runtime: parseJson(command.runtimeJson, {}),
    payload: parsed.payload,
    createdAt: parsed.createdAt
  };
}

function deriveSessionUpdate(events, session) {
  const update = {
    status: null,
    appThreadId: null,
    activeTurnId: null,
    clearActiveTurnId: false,
    lastError: null,
    finalMessage: null
  };
  let agentMessageCompleted = hasCompletedAgentMessage(session.id);

  for (const event of events || []) {
    const raw = event.raw || {};
    const method = raw.method || event.type;
    if (event.sessionStatus) update.status = String(event.sessionStatus);
    if (event.appThreadId) update.appThreadId = String(event.appThreadId);
    if (event.activeTurnId) update.activeTurnId = String(event.activeTurnId);
    if (event.clearActiveTurnId) update.clearActiveTurnId = true;
    if (event.error) update.lastError = String(event.error).slice(0, 12000);
    if (event.finalMessage && !(method === "item/agentMessage/delta" && agentMessageCompleted)) {
      update.finalMessage = String(event.finalMessage).slice(0, 12000);
    }
    if (method === "turn/started") {
      update.status = "running";
      update.activeTurnId = raw.params?.turn?.id || event.activeTurnId || update.activeTurnId;
    }
    if (method === "turn/completed") {
      const turnStatus = raw.params?.turn?.status;
      update.clearActiveTurnId = true;
      update.status = turnStatus === "failed" ? "failed" : "active";
      const message = raw.params?.turn?.error?.message;
      if (message) update.lastError = String(message).slice(0, 12000);
    }
    if (method === "item/agentMessage/delta" && event.text && !agentMessageCompleted) {
      update.finalMessage = `${session.finalMessage || ""}${event.text}`.slice(0, 12000);
    }
    if (method === "item/completed" && raw.params?.item?.type === "agentMessage") {
      update.finalMessage = String(raw.params.item.text || "").slice(0, 12000);
      agentMessageCompleted = true;
    }
  }

  return update;
}

function hasCompletedAgentMessage(sessionId) {
  const rows = db.prepare(`
    SELECT raw_json AS rawJson
    FROM codex_session_events
    WHERE session_id = ?
      AND type = 'item/completed'
    ORDER BY id DESC
    LIMIT 20
  `).all(sessionId);

  return rows.some((row) => parseJson(row.rawJson, {})?.params?.item?.type === "agentMessage");
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

function canMutateSession(session, agentId) {
  const providedAgentId = String(agentId || "").trim();
  if (!session.leasedBy || !providedAgentId) return false;
  return session.leasedBy === normalizeAgentId(providedAgentId);
}

function canMutateRunningJob(job, agentId) {
  const providedAgentId = String(agentId || "").trim();
  if (job.status !== "running" || !job.leasedBy || !providedAgentId) return false;
  return job.leasedBy === normalizeAgentId(providedAgentId);
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
        approvalPolicy: String(runtime.approvalPolicy || "").trim(),
        model: String(runtime.model || "").trim(),
        reasoningEffort: String(runtime.reasoningEffort || runtime.effort || "").trim().toLowerCase(),
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

function reclaimExpiredSessionCommandLeases() {
  const now = nowIso();
  const expired = db.prepare(`
    SELECT c.id, c.session_id AS sessionId, c.type, c.leased_by AS leasedBy
    FROM codex_session_commands c
    WHERE c.status = 'leased'
      AND c.lease_expires_at IS NOT NULL
      AND c.lease_expires_at < ?
  `).all(now);

  if (expired.length === 0) return;

  const reclaim = db.transaction(() => {
    for (const command of expired) {
      db.prepare(`
        UPDATE codex_session_commands
        SET status = 'queued',
            leased_by = NULL,
            lease_expires_at = NULL,
            updated_at = @now
        WHERE id = @id
          AND status = 'leased'
      `).run({ id: command.id, now });

      const nextStatus = command.type === "start" ? "queued" : "active";
      db.prepare(`
        UPDATE codex_sessions
        SET status = @status,
            leased_by = NULL,
            lease_expires_at = NULL,
            updated_at = @now
        WHERE id = @sessionId
      `).run({
        sessionId: command.sessionId,
        status: nextStatus,
        now
      });

      insertSessionEvent.run(
        normalizeSessionEvent(command.sessionId, {
          type: "command.lease.expired",
          text: `Desktop agent ${command.leasedBy || "unknown"} stopped renewing ${command.type}; it returned to the queue.`
        }, now)
      );
    }
  });

  reclaim();
}

function trimOldSessions() {
  const ids = db.prepare(`
    SELECT id
    FROM codex_sessions
    WHERE status IN ('failed', 'closed', 'stale')
      AND id NOT IN (
        SELECT id
        FROM codex_sessions
        ORDER BY updated_at DESC
        LIMIT 100
      )
  `).all().map((row) => row.id);

  if (ids.length === 0) return;

  const remove = db.prepare("DELETE FROM codex_sessions WHERE id = ?");
  const removeMany = db.transaction((sessionIds) => {
    for (const id of sessionIds) remove.run(id);
  });
  removeMany(ids);
}

function expireOldApprovals() {
  const cutoff = new Date(Date.now() - config.codex.approvalTimeoutMs).toISOString();
  const expired = db.prepare(`
    SELECT ${summarizeSessionApprovalColumns}
    FROM codex_session_approvals
    WHERE status = 'pending'
      AND created_at < ?
  `).all(cutoff).map(summarizeSessionApproval);

  if (expired.length === 0) return;

  const expire = db.transaction(() => {
    const now = nowIso();
    for (const approval of expired) {
      const response = buildApprovalResponse(approval.method, "timed_out");
      db.prepare(`
        UPDATE codex_session_approvals
        SET status = 'timed_out',
            response_json = @responseJson,
            decided_at = @now,
            decided_by = 'timeout',
            updated_at = @now
        WHERE id = @id
          AND status = 'pending'
      `).run({
        id: approval.id,
        responseJson: JSON.stringify(response),
        now
      });

      insertSessionEvent.run(
        normalizeSessionEvent(approval.sessionId, {
          type: "approval.timed_out",
          text: `${approval.method} approval timed out.`,
          raw: { approvalId: approval.id, response }
        }, now)
      );
    }
  });

  expire();
}

function normalizeApprovalStatus(value) {
  const decision = String(value || "").toLowerCase();
  if (["approve", "approved", "accept", "yes", "allow"].includes(decision)) return "approved";
  if (["timeout", "timed_out"].includes(decision)) return "timed_out";
  return "denied";
}

function buildApprovalResponse(method, status) {
  const approved = status === "approved";
  if (method === "item/commandExecution/requestApproval") return { decision: approved ? "accept" : status === "timed_out" ? "cancel" : "decline" };
  if (method === "item/fileChange/requestApproval") return { decision: approved ? "accept" : status === "timed_out" ? "cancel" : "decline" };
  if (method === "execCommandApproval") return { decision: approved ? "approved" : status === "timed_out" ? "timed_out" : "denied" };
  if (method === "applyPatchApproval") return { decision: approved ? "approved" : status === "timed_out" ? "timed_out" : "denied" };
  return { decision: approved ? "accept" : "decline" };
}

function badRequest(message) {
  throwHttpError(400, message);
}

function notFound(message) {
  throwHttpError(404, message);
}

function conflict(message) {
  throwHttpError(409, message);
}

function throwHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function nowIso() {
  return new Date().toISOString();
}
