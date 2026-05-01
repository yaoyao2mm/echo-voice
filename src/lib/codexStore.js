import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import {
  codexCompatibleModel,
  normalizeAllowedPermissionModes,
  normalizePermissionMode,
  normalizeReasoningEffort,
  normalizeSupportedModels,
  permissionModeFromRuntime,
  sanitizeRuntimeForAgent
} from "./codexRuntime.js";

const dbPath = path.join(config.dataDir, "echo.sqlite");
const attachmentStorageDir = path.join(config.dataDir, "codex-attachments");
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(attachmentStorageDir, { recursive: true });

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

const insertSessionMessage = db.prepare(`
  INSERT INTO codex_session_messages (
    id, session_id, role, text, command_id, external_key, created_at, updated_at
  ) VALUES (
    @id, @sessionId, @role, @text, @commandId, @externalKey, @createdAt, @updatedAt
  )
`);

const insertSessionMessageIgnore = db.prepare(`
  INSERT OR IGNORE INTO codex_session_messages (
    id, session_id, role, text, command_id, external_key, created_at, updated_at
  ) VALUES (
    @id, @sessionId, @role, @text, @commandId, @externalKey, @createdAt, @updatedAt
  )
`);

const insertSessionAttachment = db.prepare(`
  INSERT INTO codex_session_attachments (
    id, session_id, message_id, type, original_name, mime_type, size_bytes, sha256, storage_key, created_at
  ) VALUES (
    @id, @sessionId, @messageId, @type, @originalName, @mimeType, @sizeBytes, @sha256, @storageKey, @createdAt
  )
`);

const insertSessionCommand = db.prepare(`
  INSERT INTO codex_session_commands (
    id, session_id, type, payload_json, status, created_at, updated_at
  ) VALUES (
    @id, @sessionId, @type, @payloadJson, 'queued', @now, @now
  )
`);

const insertWorkspaceCommand = db.prepare(`
  INSERT INTO codex_workspace_commands (
    id, type, payload_json, status, result_json, created_at, updated_at
  ) VALUES (
    @id, @type, @payloadJson, 'queued', '{}', @now, @now
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
  runtime_json AS runtimeJson,
  execution_json AS executionJson
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

const summarizeWorkspaceCommandColumns = `
  id,
  type,
  payload_json AS payloadJson,
  status,
  result_json AS resultJson,
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

const summarizeSessionMessageColumns = `
  id,
  session_id AS sessionId,
  role,
  text,
  command_id AS commandId,
  external_key AS externalKey,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const summarizeSessionAttachmentColumns = `
  id,
  session_id AS sessionId,
  message_id AS messageId,
  type,
  original_name AS originalName,
  mime_type AS mimeType,
  size_bytes AS sizeBytes,
  sha256,
  storage_key AS storageKey,
  created_at AS createdAt
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
  reclaimExpiredWorkspaceCommandLeases();

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
    runtime: mergeAgentRuntimes(onlineAgents, primaryAgent?.runtime || {}),
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

export function createSession({ projectId, prompt, attachments, runtime, mode }) {
  const now = nowIso();
  const sessionId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const normalizedPrompt = String(prompt || "").trim();
  const normalizedProjectId = String(projectId || "").trim();
  const commandMode = normalizeSessionMode(mode);
  const stagedAttachments = stageSessionAttachments({ sessionId, messageId, attachments, createdAt: now });
  const normalizedRuntime = sanitizeSessionRuntimeForProject(runtime, normalizedProjectId);
  if (!normalizedPrompt && stagedAttachments.length === 0) {
    cleanupStagedAttachments(stagedAttachments);
    return badRequest("Codex session prompt or screenshot is required.");
  }
  const title = sessionTitleFromInput(normalizedPrompt, stagedAttachments);

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
      payloadJson: JSON.stringify({ messageId, mode: commandMode }),
      now
    });

    insertSessionMessage.run({
      id: messageId,
      sessionId,
      role: "user",
      text: normalizedPrompt,
      commandId,
      externalKey: `user:${commandId}`,
      createdAt: now,
      updatedAt: now
    });

    for (const attachment of stagedAttachments) {
      insertSessionAttachment.run(attachment);
    }

    insertSessionEvent.run(
      normalizeSessionEvent(sessionId, {
        type: "user.message",
        text: normalizedPrompt,
        raw: { source: "mobile", commandId, type: "start", messageId, mode: commandMode, attachments: attachmentRefsFromRows(stagedAttachments) }
      }, now)
    );
  });

  try {
    create();
  } catch (error) {
    cleanupStagedAttachments(stagedAttachments);
    throw error;
  }
  trimOldSessions();
  return getSessionSummary(sessionId);
}

export function listSessions(limit = 20, options = {}) {
  refreshInteractiveSessionState();
  const archived = Boolean(options.archived);
  const projectId = String(options.projectId || "").trim();
  const clauses = [`archived_at ${archived ? "IS NOT NULL" : "IS NULL"}`];
  const params = {
    limit: Math.max(1, Math.min(Number(limit) || 20, 100))
  };
  if (projectId) {
    clauses.push("project_id = @projectId");
    params.projectId = projectId;
  }

  return db.prepare(`
    SELECT ${summarizeSessionColumns}
    FROM codex_sessions
    WHERE ${clauses.join(" AND ")}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT @limit
  `).all(params).map(summarizeSession);
}

export function getSession(id) {
  refreshInteractiveSessionState();

  const session = getSessionSummary(id);
  if (!session) return null;
  return {
    ...session,
    messages: listSessionMessages(id),
    events: listSessionEvents(id),
    approvals: listSessionApprovals(id)
  };
}

export function getSessionAttachmentContent(id) {
  const attachment = getSessionAttachment(id);
  if (!attachment) return null;
  return {
    ...attachment,
    filePath: attachmentAbsolutePath(attachment.storageKey)
  };
}

export function archiveSession(id, input = {}) {
  refreshInteractiveSessionState();
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
  refreshInteractiveSessionState();
  const session = getSessionSummary(sessionId);
  if (!session) return notFound("Codex session not found.");
  const expectedProjectId = String(input.projectId || input.expectedProjectId || "").trim();
  if (expectedProjectId && session.projectId !== expectedProjectId) {
    return conflict("This Codex session belongs to a different project.");
  }
  if (session.archivedAt) return conflict("Restore this Codex session before continuing it.");
  const recoverableFailure = session.status === "failed" && sessionCanRecoverFailure(session);
  if (["cancelled", "closed", "stale"].includes(session.status) || (session.status === "failed" && !recoverableFailure)) {
    return conflict("This Codex session is no longer active.");
  }

  const now = nowIso();
  const commandId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const message = String(input.text || input.prompt || "").trim();
  const mode = normalizeSessionMode(input.mode);
  const stagedAttachments = stageSessionAttachments({ sessionId, messageId, attachments: input.attachments, createdAt: now });
  const runtime = sanitizeSessionRuntimeForProject(
    Object.keys(input.runtime || {}).length > 0 ? input.runtime : session.runtime,
    session.projectId
  );
  if (!message && stagedAttachments.length === 0) {
    cleanupStagedAttachments(stagedAttachments);
    return badRequest("Codex message or screenshot is required.");
  }

  const enqueue = db.transaction(() => {
    insertSessionCommand.run({
      id: commandId,
      sessionId,
      type: "message",
      payloadJson: JSON.stringify({ messageId, mode }),
      now
    });

    db.prepare(`
      UPDATE codex_sessions
      SET updated_at = @now,
          runtime_json = @runtimeJson,
          status = CASE WHEN @recoverableFailure = 1 THEN 'active' WHEN status = 'queued' THEN 'queued' ELSE status END,
          last_error = CASE WHEN @recoverableFailure = 1 THEN '' ELSE last_error END
      WHERE id = @sessionId
    `).run({ sessionId, now, runtimeJson: JSON.stringify(runtime), recoverableFailure: recoverableFailure ? 1 : 0 });

    insertSessionMessage.run({
      id: messageId,
      sessionId,
      role: "user",
      text: message,
      commandId,
      externalKey: `user:${commandId}`,
      createdAt: now,
      updatedAt: now
    });

    for (const attachment of stagedAttachments) {
      insertSessionAttachment.run(attachment);
    }

    insertSessionEvent.run(
      normalizeSessionEvent(sessionId, {
        type: "user.message",
        text: message,
        raw: { source: "mobile", commandId, type: "message", messageId, mode, attachments: attachmentRefsFromRows(stagedAttachments) }
      }, now)
    );
  });

  try {
    enqueue();
  } catch (error) {
    cleanupStagedAttachments(stagedAttachments);
    throw error;
  }
  return getSession(sessionId);
}

export function compactSession(sessionId, input = {}) {
  refreshInteractiveSessionState();
  const session = getSessionSummary(sessionId);
  if (!session) return notFound("Codex session not found.");
  if (session.archivedAt) return conflict("Restore this Codex session before compacting it.");
  if (!session.appThreadId) return conflict("This Codex session has no app-server thread to compact yet.");
  if (!sessionCanCompact(session)) return conflict("Wait for the current Codex turn to finish before compacting context.");

  const now = nowIso();
  const commandId = crypto.randomUUID();
  const automatic = Boolean(input.automatic);
  const reason = String(input.reason || "").trim().slice(0, 240);

  const enqueue = db.transaction(() => {
    insertSessionCommand.run({
      id: commandId,
      sessionId,
      type: "compact",
      payloadJson: JSON.stringify({ automatic, reason }),
      now
    });

    db.prepare(`
      UPDATE codex_sessions
      SET updated_at = @now
      WHERE id = @sessionId
    `).run({ sessionId, now });

    insertSessionEvent.run(
      normalizeSessionEvent(sessionId, {
        type: "context.compaction.queued",
        text: automatic ? "Context compaction queued automatically." : "Context compaction requested from mobile.",
        raw: { source: "mobile", commandId, type: "compact", automatic, reason }
      }, now)
    );
  });

  enqueue();
  return getSession(sessionId);
}

export function cancelSession(sessionId, input = {}) {
  refreshInteractiveSessionState();
  const session = getSessionSummary(sessionId);
  if (!session) return notFound("Codex session not found.");
  if (session.archivedAt) return conflict("Restore this Codex session before cancelling it.");
  if (["closed", "cancelled", "stale"].includes(session.status)) return session;

  const now = nowIso();
  const reason = String(input.reason || "Cancelled from mobile.").trim().slice(0, 240) || "Cancelled from mobile.";

  if (session.status === "queued" && !session.leasedBy && !session.appThreadId) {
    const cancelQueued = db.transaction(() => {
      db.prepare(`
        UPDATE codex_session_commands
        SET status = 'failed',
            error = @reason,
            updated_at = @now
        WHERE session_id = @sessionId
          AND status = 'queued'
      `).run({ sessionId, reason, now });

      db.prepare(`
        UPDATE codex_sessions
        SET status = 'cancelled',
            active_turn_id = NULL,
            leased_by = NULL,
            lease_expires_at = NULL,
            last_error = '',
            updated_at = @now
        WHERE id = @sessionId
      `).run({ sessionId, now });

      denyPendingSessionApprovals(sessionId, now, "cancelled");

      insertSessionEvent.run(
        normalizeSessionEvent(sessionId, {
          type: "session.cancelled",
          text: reason,
          raw: { source: "mobile", reason }
        }, now)
      );
    });
    cancelQueued();
    return getSession(sessionId);
  }

  if (!session.activeTurnId && session.status !== "starting" && session.status !== "running" && session.pendingCommandCount === 0) {
    return conflict("This Codex session does not have an active turn to cancel.");
  }

  const enqueueStop = db.transaction(() => {
    db.prepare(`
      UPDATE codex_session_commands
      SET status = 'failed',
          error = @reason,
          updated_at = @now
      WHERE session_id = @sessionId
        AND status = 'queued'
        AND type <> 'stop'
    `).run({ sessionId, reason, now });

    if (!sessionHasQueuedStopCommand(sessionId)) {
      insertSessionCommand.run({
        id: crypto.randomUUID(),
        sessionId,
        type: "stop",
        payloadJson: JSON.stringify({ reason }),
        now
      });
    }

    db.prepare(`
      UPDATE codex_sessions
      SET updated_at = @now
      WHERE id = @sessionId
    `).run({ sessionId, now });

    denyPendingSessionApprovals(sessionId, now, "cancelled");

    insertSessionEvent.run(
      normalizeSessionEvent(sessionId, {
        type: "turn.cancel.requested",
        text: reason,
        raw: { source: "mobile", type: "stop", reason }
      }, now)
    );
  });

  enqueueStop();
  return getSession(sessionId);
}

export function createWorkspaceCommand(input = {}) {
  reclaimExpiredWorkspaceCommandLeases();

  const name = normalizeWorkspaceName(input.name || input.label);
  if (!name) return badRequest("Workspace name is required.");

  const now = nowIso();
  const command = {
    id: crypto.randomUUID(),
    type: "create",
    payloadJson: JSON.stringify({
      name,
      label: name,
      requestedBy: String(input.requestedBy || "mobile").slice(0, 120)
    }),
    now
  };

  insertWorkspaceCommand.run(command);
  return getWorkspaceCommand(command.id);
}

export function getWorkspaceCommand(id) {
  reclaimExpiredWorkspaceCommandLeases();
  const row = db.prepare(`
    SELECT ${summarizeWorkspaceCommandColumns}
    FROM codex_workspace_commands
    WHERE id = ?
  `).get(id);
  return row ? summarizeWorkspaceCommand(row) : null;
}

export function acquireNextWorkspaceCommand({ agentId } = {}) {
  reclaimExpiredWorkspaceCommandLeases();

  const leaseHolder = normalizeAgentId(agentId);
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();

  const acquire = db.transaction(() => {
    const command = db.prepare(`
      SELECT ${summarizeWorkspaceCommandColumns}
      FROM codex_workspace_commands
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `).get();

    if (!command) return null;

    db.prepare(`
      UPDATE codex_workspace_commands
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

    return getWorkspaceCommand(command.id);
  });

  return acquire();
}

export function completeWorkspaceCommand(commandId, result = {}, options = {}) {
  const command = getWorkspaceCommand(commandId);
  if (!command) return false;
  const providedAgentId = normalizeAgentId(options.agentId);
  if (command.status !== "leased" || command.leasedBy !== providedAgentId) return false;

  const now = nowIso();
  const ok = result.ok === true;
  const error = String(result.error || "").slice(0, 12000);
  db.prepare(`
    UPDATE codex_workspace_commands
    SET status = @status,
        result_json = @resultJson,
        error = @error,
        leased_by = NULL,
        lease_expires_at = NULL,
        updated_at = @now
    WHERE id = @commandId
      AND status = 'leased'
      AND leased_by = @leasedBy
  `).run({
    commandId,
    status: ok ? "done" : "failed",
    resultJson: JSON.stringify(result || {}).slice(0, 30000),
    error,
    now,
    leasedBy: providedAgentId
  });

  return true;
}

export function acquireNextSessionCommand({ agentId, workspaces = [] } = {}) {
  refreshInteractiveSessionState();

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
        s.runtime_json AS runtimeJson,
        s.execution_json AS executionJson
      FROM codex_session_commands c
      JOIN codex_sessions s ON s.id = c.session_id
      WHERE c.status = 'queued'
        AND s.status NOT IN ('closed', 'failed', 'cancelled', 'stale')
        AND s.project_id IN (${placeholders})
      ORDER BY CASE WHEN c.type = 'stop' THEN 0 ELSE 1 END, c.created_at ASC
      LIMIT 1
    `).get(...workspaceIds);

    if (!command) return null;

    const agentRuntime = runtimeForAgentAndProject(leaseHolder, command.projectId);
    const runtime = sanitizeRuntimeForAgent(parseJson(command.runtimeJson, {}), agentRuntime);
    const runtimeJson = JSON.stringify(runtime);

    db.prepare(`
      UPDATE codex_sessions
      SET runtime_json = @runtimeJson
      WHERE id = @sessionId
    `).run({
      sessionId: command.sessionId,
      runtimeJson
    });

    command.runtimeJson = runtimeJson;

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
  const releaseLease = update.releaseLease && !sessionHasLeasedCommand(sessionId);
  const assistantMessages = buildAssistantMessages(sessionId, incomingEvents, now);

  const write = db.transaction(() => {
    db.prepare(`
      UPDATE codex_sessions
      SET leased_by = CASE WHEN @releaseLease = 1 THEN NULL ELSE leased_by END,
          lease_expires_at = CASE WHEN @releaseLease = 1 THEN NULL ELSE @leaseExpiresAt END,
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
      releaseLease: releaseLease ? 1 : 0,
      lastError: update.lastError,
      finalMessage: update.finalMessage
    });

    for (const event of events) insertSessionEvent.run(event);
    for (const message of assistantMessages) {
      insertSessionMessageIgnore.run(message);
    }
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
  const clearActiveTurnId = sessionStatus !== "running";
  const releaseLease = sessionStatus !== "running";
  const executionJson = result.execution && typeof result.execution === "object" ? JSON.stringify(result.execution) : null;

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
          active_turn_id = CASE WHEN @clearActiveTurnId = 1 THEN NULL ELSE COALESCE(@activeTurnId, active_turn_id) END,
          last_error = @lastError,
          final_message = COALESCE(@finalMessage, final_message),
          execution_json = COALESCE(@executionJson, execution_json),
          leased_by = CASE WHEN @releaseLease = 1 THEN NULL ELSE leased_by END,
          lease_expires_at = CASE WHEN @releaseLease = 1 THEN NULL ELSE lease_expires_at END,
          updated_at = @now
      WHERE id = @sessionId
        AND leased_by = @leasedBy
    `).run({
      sessionId: command.sessionId,
      sessionStatus,
      appThreadId: result.appThreadId || null,
      activeTurnId,
      clearActiveTurnId: clearActiveTurnId ? 1 : 0,
      releaseLease: releaseLease ? 1 : 0,
      lastError: error,
      finalMessage: result.finalMessage || null,
      executionJson,
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
  db.prepare("DELETE FROM codex_workspace_commands").run();
  db.prepare("DELETE FROM codex_session_attachments").run();
  db.prepare("DELETE FROM codex_session_messages").run();
  db.prepare("DELETE FROM codex_session_approvals").run();
  db.prepare("DELETE FROM codex_session_events").run();
  db.prepare("DELETE FROM codex_session_commands").run();
  db.prepare("DELETE FROM codex_sessions").run();
  db.prepare("DELETE FROM codex_events").run();
  db.prepare("DELETE FROM codex_jobs").run();
  db.prepare("DELETE FROM codex_agents").run();
  fs.rmSync(attachmentStorageDir, { recursive: true, force: true });
  fs.mkdirSync(attachmentStorageDir, { recursive: true });
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
      status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'active', 'running', 'failed', 'cancelled', 'closed', 'stale')),
      app_thread_id TEXT,
      active_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      final_message TEXT NOT NULL DEFAULT '',
      leased_by TEXT,
      lease_expires_at TEXT,
      archived_at TEXT,
      runtime_json TEXT NOT NULL DEFAULT '{}',
      execution_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_status_updated
      ON codex_sessions(status, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_thread
      ON codex_sessions(app_thread_id);

    CREATE TABLE IF NOT EXISTS codex_session_commands (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('start', 'message', 'stop', 'compact')),
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

    CREATE TABLE IF NOT EXISTS codex_workspace_commands (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('create')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed')),
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      leased_by TEXT,
      lease_expires_at TEXT,
      error TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_codex_workspace_commands_status_created
      ON codex_workspace_commands(status, created_at);

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

    CREATE TABLE IF NOT EXISTS codex_session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      text TEXT NOT NULL DEFAULT '',
      command_id TEXT,
      external_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, external_key)
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_messages_session
      ON codex_session_messages(session_id, created_at, id);

    CREATE TABLE IF NOT EXISTS codex_session_attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES codex_session_messages(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('image')),
      original_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      storage_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(storage_key)
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_attachments_message
      ON codex_session_attachments(message_id, created_at, id);

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
  ensureColumn("codex_sessions", "execution_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureSessionStatuses();
  repairSessionForeignKeyReferences();
  ensureSessionCommandTypes();
  repairSessionForeignKeyReferences();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_codex_sessions_status_updated
      ON codex_sessions(status, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_thread
      ON codex_sessions(app_thread_id);

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_archived_updated
      ON codex_sessions(archived_at, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_project_archived_updated
      ON codex_sessions(project_id, archived_at, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_commands_status_created
      ON codex_session_commands(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_commands_session
      ON codex_session_commands(session_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_events_session_id
      ON codex_session_events(session_id, id);

    CREATE INDEX IF NOT EXISTS idx_codex_session_messages_session
      ON codex_session_messages(session_id, created_at, id);

    CREATE INDEX IF NOT EXISTS idx_codex_session_attachments_message
      ON codex_session_attachments(message_id, created_at, id);

    CREATE INDEX IF NOT EXISTS idx_codex_session_approvals_session
      ON codex_session_approvals(session_id, status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_approvals_status
      ON codex_session_approvals(status, created_at);
  `);
}

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((info) => info.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function ensureSessionStatuses() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_sessions'").get()?.sql || "";
  if (schema.includes("'cancelled'")) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    BEGIN TRANSACTION;
    ALTER TABLE codex_sessions RENAME TO codex_sessions_old;
    CREATE TABLE codex_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'active', 'running', 'failed', 'cancelled', 'closed', 'stale')),
      app_thread_id TEXT,
      active_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      final_message TEXT NOT NULL DEFAULT '',
      leased_by TEXT,
      lease_expires_at TEXT,
      archived_at TEXT,
      runtime_json TEXT NOT NULL DEFAULT '{}',
      execution_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO codex_sessions (
      id,
      project_id,
      title,
      status,
      app_thread_id,
      active_turn_id,
      created_at,
      updated_at,
      last_error,
      final_message,
      leased_by,
      lease_expires_at,
      archived_at,
      runtime_json,
      execution_json
    )
    SELECT
      id,
      project_id,
      title,
      status,
      app_thread_id,
      active_turn_id,
      created_at,
      updated_at,
      last_error,
      final_message,
      leased_by,
      lease_expires_at,
      archived_at,
      runtime_json,
      execution_json
    FROM codex_sessions_old;
    DROP TABLE codex_sessions_old;
    COMMIT;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `);
}

function repairSessionForeignKeyReferences() {
  const brokenTables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND sql LIKE '%codex_sessions_old%'
  `).all();
  if (brokenTables.length === 0) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
  `);

  try {
    const repair = db.transaction(() => {
      const names = brokenTables.map((table) => table.name).filter((name) => sessionChildTableSchema(name));
      for (const name of names) {
        const backupName = repairTableName(name);
        db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(backupName)}`);
        db.exec(`ALTER TABLE ${quoteIdentifier(name)} RENAME TO ${quoteIdentifier(backupName)}`);
      }
      for (const name of names) {
        db.exec(sessionChildTableSchema(name));
        copyCommonColumns(repairTableName(name), name);
        db.exec(`DROP TABLE ${quoteIdentifier(repairTableName(name))}`);
      }
    });
    repair();
  } finally {
    db.exec(`
      PRAGMA legacy_alter_table = OFF;
      PRAGMA foreign_keys = ON;
    `);
  }
}

function sessionChildTableSchema(name) {
  if (name === "codex_session_commands") {
    return `
      CREATE TABLE codex_session_commands (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('start', 'message', 'stop', 'compact')),
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        leased_by TEXT,
        lease_expires_at TEXT,
        error TEXT NOT NULL DEFAULT ''
      )
    `;
  }
  if (name === "codex_session_events") {
    return `
      CREATE TABLE codex_session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        raw_json TEXT
      )
    `;
  }
  if (name === "codex_session_messages") {
    return `
      CREATE TABLE codex_session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        text TEXT NOT NULL DEFAULT '',
        command_id TEXT,
        external_key TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, external_key)
      )
    `;
  }
  if (name === "codex_session_attachments") {
    return `
      CREATE TABLE codex_session_attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES codex_session_messages(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('image')),
        original_name TEXT NOT NULL DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        storage_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(storage_key)
      )
    `;
  }
  if (name === "codex_session_approvals") {
    return `
      CREATE TABLE codex_session_approvals (
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
      )
    `;
  }
  return "";
}

function copyCommonColumns(fromTable, toTable) {
  const fromColumns = tableColumns(fromTable);
  const toColumns = tableColumns(toTable);
  const fromColumnNames = new Set(fromColumns.map((column) => column.name));
  const commonColumns = toColumns.map((column) => column.name).filter((name) => fromColumnNames.has(name));
  if (commonColumns.length === 0) return;

  const columnList = commonColumns.map(quoteIdentifier).join(", ");
  db.prepare(`
    INSERT INTO ${quoteIdentifier(toTable)} (${columnList})
    SELECT ${columnList}
    FROM ${quoteIdentifier(fromTable)}
  `).run();
}

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
}

function repairTableName(name) {
  return `__echo_repair_${name}`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function ensureSessionCommandTypes() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_session_commands'").get()?.sql || "";
  if (schema.includes("'compact'")) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    BEGIN TRANSACTION;
    ALTER TABLE codex_session_commands RENAME TO codex_session_commands_old;
    CREATE TABLE codex_session_commands (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('start', 'message', 'stop', 'compact')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      leased_by TEXT,
      lease_expires_at TEXT,
      error TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO codex_session_commands (
      id, session_id, type, payload_json, status, created_at, updated_at, leased_by, lease_expires_at, error
    )
    SELECT id, session_id, type, payload_json, status, created_at, updated_at, leased_by, lease_expires_at, error
    FROM codex_session_commands_old;
    DROP TABLE codex_session_commands_old;
    COMMIT;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;

    CREATE INDEX IF NOT EXISTS idx_codex_session_commands_status_created
      ON codex_session_commands(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_commands_session
      ON codex_session_commands(session_id, created_at);
  `);
  db.pragma("foreign_keys = ON");
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

function mergeAgentRuntimes(agents, primaryRuntime = {}) {
  const unsupportedModels = new Set();
  for (const agent of agents || []) {
    for (const model of agent.runtime?.unsupportedModels || []) {
      const normalized = String(model || "").trim();
      if (normalized) unsupportedModels.add(normalized);
    }
  }
  return {
    ...primaryRuntime,
    unsupportedModels: [...unsupportedModels]
  };
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
    lastEvent: lastEvent ? parseEvent(lastEvent, { includeRaw: false }) : null
  };
}

function sessionStatusSnapshot() {
  refreshInteractiveSessionState();

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
    execution: parseJson(row.executionJson, {}),
    eventCount,
    pendingCommandCount,
    pendingApprovalCount,
    lastEvent: lastEvent ? parseEvent(lastEvent, { includeRaw: false }) : null
  };
}

function summarizeSessionCommand(row) {
  return {
    ...row,
    payload: parseJson(row.payloadJson, {})
  };
}

function summarizeWorkspaceCommand(row) {
  return {
    ...row,
    payload: parseJson(row.payloadJson, {}),
    result: parseJson(row.resultJson, {})
  };
}

function summarizeSessionMessage(row, attachments = []) {
  return {
    ...row,
    attachments
  };
}

function summarizeSessionAttachment(row) {
  return {
    ...row,
    name: row.originalName,
    downloadPath: `/api/codex/attachments/${encodeURIComponent(row.id)}`
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

function listSessionMessages(sessionId) {
  const rows = db.prepare(`
    SELECT ${summarizeSessionMessageColumns}
    FROM codex_session_messages
    WHERE session_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(sessionId);
  const attachmentsByMessageId = listSessionAttachmentsBySession(sessionId);
  return rows.map((row) => summarizeSessionMessage(row, attachmentsByMessageId.get(row.id) || []));
}

function getSessionMessage(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionMessageColumns}
    FROM codex_session_messages
    WHERE id = ?
  `).get(id);
  if (!row) return null;
  return summarizeSessionMessage(row, listMessageAttachments(id));
}

function getSessionAttachment(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionAttachmentColumns}
    FROM codex_session_attachments
    WHERE id = ?
  `).get(id);
  return row ? summarizeSessionAttachment(row) : null;
}

function listMessageAttachments(messageId) {
  return db.prepare(`
    SELECT ${summarizeSessionAttachmentColumns}
    FROM codex_session_attachments
    WHERE message_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(messageId).map(summarizeSessionAttachment);
}

function listSessionAttachmentsBySession(sessionId) {
  const rows = db.prepare(`
    SELECT ${summarizeSessionAttachmentColumns}
    FROM codex_session_attachments
    WHERE session_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(sessionId);
  const byMessageId = new Map();
  for (const row of rows) {
    const attachment = summarizeSessionAttachment(row);
    const existing = byMessageId.get(attachment.messageId) || [];
    existing.push(attachment);
    byMessageId.set(attachment.messageId, existing);
  }
  return byMessageId;
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

function sessionHasLeasedCommand(sessionId) {
  return (
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM codex_session_commands
      WHERE session_id = ?
        AND status = 'leased'
    `).get(sessionId).count > 0
  );
}

function sessionHasQueuedStopCommand(sessionId) {
  return (
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM codex_session_commands
      WHERE session_id = ?
        AND type = 'stop'
        AND status IN ('queued', 'leased')
    `).get(sessionId).count > 0
  );
}

function denyPendingSessionApprovals(sessionId, now, decidedBy) {
  const approvals = db.prepare(`
    SELECT ${summarizeSessionApprovalColumns}
    FROM codex_session_approvals
    WHERE session_id = ?
      AND status = 'pending'
  `).all(sessionId).map(summarizeSessionApproval);

  for (const approval of approvals) {
    const response = buildApprovalResponse(approval.method, "denied");
    db.prepare(`
      UPDATE codex_session_approvals
      SET status = 'denied',
          response_json = @responseJson,
          decided_at = @now,
          decided_by = @decidedBy,
          updated_at = @now
      WHERE id = @id
        AND status = 'pending'
    `).run({
      id: approval.id,
      responseJson: JSON.stringify(response),
      now,
      decidedBy
    });

    insertSessionEvent.run(
      normalizeSessionEvent(approval.sessionId, {
        type: "approval.denied",
        text: `${approval.method} denied by cancellation.`,
        raw: { approvalId: approval.id, response }
      }, now)
    );
  }
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
    rawJson: raw ? JSON.stringify(raw) : null
  };
}

function parseEvent(row, options = {}) {
  return {
    at: row.at,
    type: row.type,
    text: row.text,
    raw: options.includeRaw === false ? null : parseJson(row.rawJson)
  };
}

function buildAgentSessionCommand(command) {
  const parsed = summarizeSessionCommand(command);
  const messageId = String(parsed.payload?.messageId || "").trim();
  const message = messageId ? getSessionMessage(messageId) : null;
  const mode = normalizeSessionMode(parsed.payload?.mode);
  const agentText = message ? promptForSessionMode(message.text, mode) : "";
  const payload = {
    ...parsed.payload,
    ...(message
      ? parsed.type === "start"
        ? { prompt: agentText, displayText: message.text, attachments: commandAttachmentsFromMessage(message) }
        : { text: agentText, displayText: message.text, attachments: commandAttachmentsFromMessage(message) }
      : {})
  };
  if (parsed.type === "message") {
    payload.history = commandHistoryForSession(parsed.sessionId, message?.id);
  }
  return {
    id: parsed.id,
    sessionId: parsed.sessionId,
    type: parsed.type,
    projectId: command.projectId,
    appThreadId: command.appThreadId || "",
    activeTurnId: command.activeTurnId || "",
    runtime: parseJson(command.runtimeJson, {}),
    execution: parseJson(command.executionJson, {}),
    payload,
    createdAt: parsed.createdAt
  };
}

function normalizeSessionMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "plan" ? "plan" : "execute";
}

function promptForSessionMode(text, mode) {
  const normalized = String(text || "").trim();
  if (mode !== "plan" || !normalized) return normalized;
  return [
    "请先进入计划模式，只分析并给出可执行计划。",
    "不要修改文件，不要提交、推送、部署，也不要运行会改变仓库状态的命令。",
    "如果需要验证，请只说明建议运行哪些检查，等待我确认后再执行。",
    "",
    "用户请求：",
    normalized
  ].join("\n");
}

function commandHistoryForSession(sessionId, currentMessageId) {
  return listSessionMessages(sessionId)
    .filter((message) => message.id !== currentMessageId)
    .filter((message) => ["user", "assistant"].includes(message.role))
    .filter((message) => String(message.text || "").trim())
    .slice(-12)
    .map((message) => ({
      role: message.role,
      text: String(message.text || "").trim().slice(0, 4000),
      createdAt: message.createdAt
    }));
}

function deriveSessionUpdate(events, session) {
  const update = {
    status: null,
    appThreadId: null,
    activeTurnId: null,
    clearActiveTurnId: false,
    releaseLease: false,
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
      update.releaseLease = true;
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

function sanitizeSessionRuntimeForProject(runtime, projectId) {
  return sanitizeRuntimeForAgent(runtime, runtimeForProject(projectId));
}

function runtimeForProject(projectId) {
  const normalizedProjectId = String(projectId || "").trim();
  const nowMs = Date.now();
  const agent = listAgents()
    .filter((item) => isAgentOnline(item, nowMs))
    .find((item) => (item.workspaces || []).some((workspace) => workspace.id === normalizedProjectId));
  return agent?.runtime || fallbackRuntimeForSanitization();
}

function runtimeForAgentAndProject(agentId, projectId) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedProjectId = String(projectId || "").trim();
  const agent = listAgents().find((item) => item.id === normalizedAgentId);
  if (!agent || !(agent.workspaces || []).some((workspace) => workspace.id === normalizedProjectId)) {
    return fallbackRuntimeForSanitization();
  }
  return agent.runtime || fallbackRuntimeForSanitization();
}

function fallbackRuntimeForSanitization() {
  return {
    sandbox: config.codex.sandbox,
    approvalPolicy: config.codex.approvalPolicy,
    model: config.codex.model,
    unsupportedModels: [],
    supportedModels: [],
    allowedPermissionModes: normalizeAllowedPermissionModes()
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

function sessionCanRecoverFailure(session = {}) {
  const error = String(session.lastError || session.error || "");
  return /thread not found|requires a newer version of Codex|Please upgrade to the latest app or CLI/i.test(error);
}

function sessionCanCompact(session = {}) {
  if (["queued", "starting", "running", "failed", "closed", "stale"].includes(session.status)) return false;
  return Number(session.pendingCommandCount || 0) === 0 && Number(session.pendingApprovalCount || 0) === 0;
}

function canMutateRunningJob(job, agentId) {
  const providedAgentId = String(agentId || "").trim();
  if (job.status !== "running" || !job.leasedBy || !providedAgentId) return false;
  return job.leasedBy === normalizeAgentId(providedAgentId);
}

function normalizeWorkspaceName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
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
  const unsupportedModels = Array.isArray(runtime.unsupportedModels)
    ? runtime.unsupportedModels.map((model) => String(model || "").trim()).filter(Boolean)
    : [];
  const supportedModels = normalizeSupportedModels(runtime.supportedModels);
  const allowedPermissionModes = Array.isArray(runtime.allowedPermissionModes)
    ? normalizeAllowedPermissionModes(runtime.allowedPermissionModes)
    : [];
  const permissionMode = normalizePermissionMode(
    runtime.permissionMode || runtime.permissionsMode || runtime.profile || permissionModeFromRuntime(runtime)
  );
  return runtime && typeof runtime === "object"
    ? {
        command: String(runtime.command || "").trim(),
        sandbox: String(runtime.sandbox || "").trim(),
        approvalPolicy: String(runtime.approvalPolicy || "").trim(),
        model: codexCompatibleModel(runtime.model),
        unsupportedModels,
        supportedModels,
        allowedPermissionModes,
        reasoningEffort: normalizeReasoningEffort(runtime.reasoningEffort || runtime.effort),
        profile: String(runtime.profile || permissionMode || "").trim(),
        permissionMode,
        worktreeMode: String(runtime.worktreeMode || "").trim(),
        modelCapabilitySource: String(runtime.modelCapabilitySource || "").trim(),
        modelCapabilityCheckedAt: String(runtime.modelCapabilityCheckedAt || "").trim(),
        modelCapabilityError: String(runtime.modelCapabilityError || "").trim(),
        timeoutMs: Number(runtime.timeoutMs || 0) || null
      }
    : {};
}

function stageSessionAttachments({ sessionId, messageId, attachments = [], createdAt }) {
  const normalized = normalizeSessionAttachments(attachments);
  const staged = [];

  for (const attachment of normalized) {
    const image = parseAttachmentDataUrl(attachment.url, attachment.mimeType);
    if (!image) continue;
    const attachmentId = crypto.randomUUID();
    const storageKey = attachmentStorageKey(sessionId, attachmentId, image.extension);
    const absolutePath = attachmentAbsolutePath(storageKey);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, image.buffer, { mode: 0o600 });
    staged.push({
      id: attachmentId,
      sessionId,
      messageId,
      type: "image",
      originalName: String(attachment.name || "").trim(),
      mimeType: image.mimeType,
      sizeBytes: clampAttachmentSizeBytes(attachment.sizeBytes || image.buffer.length),
      sha256: crypto.createHash("sha256").update(image.buffer).digest("hex"),
      storageKey,
      createdAt,
      absolutePath
    });
  }

  return staged;
}

function cleanupStagedAttachments(attachments = []) {
  for (const attachment of attachments) {
    if (!attachment?.absolutePath) continue;
    try {
      fs.rmSync(attachment.absolutePath, { force: true });
    } catch {
      // Ignore best-effort cleanup errors for staged attachment files.
    }
  }
}

function cleanupAttachmentStorageKeys(storageKeys = []) {
  for (const storageKey of storageKeys) {
    if (!storageKey) continue;
    try {
      fs.rmSync(attachmentAbsolutePath(storageKey), { force: true });
    } catch {
      // Ignore best-effort cleanup errors for persisted attachment files.
    }
  }
}

function attachmentRefsFromRows(rows = []) {
  return rows.map((row) => {
    const attachment = summarizeSessionAttachment(row);
    return {
      id: attachment.id,
      type: attachment.type,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      downloadPath: attachment.downloadPath
    };
  });
}

function commandAttachmentsFromMessage(message) {
  return (message.attachments || []).map((attachment) => ({
    type: "image",
    id: attachment.id,
    attachmentId: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    downloadPath: `/api/agent/codex/attachments/${encodeURIComponent(attachment.id)}`
  }));
}

function attachmentStorageKey(sessionId, attachmentId, extension) {
  const safeSessionId = String(sessionId || "session").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const safeAttachmentId = String(attachmentId || "attachment").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const safeExtension = String(extension || "bin").replace(/[^a-z0-9]+/gi, "").toLowerCase() || "bin";
  return `${safeSessionId}/${safeAttachmentId}.${safeExtension}`;
}

function attachmentAbsolutePath(storageKey) {
  return path.join(attachmentStorageDir, ...String(storageKey || "").split("/"));
}

function parseAttachmentDataUrl(url, fallbackMimeType = "") {
  const match = /^data:(image\/[a-z0-9.+_-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(url || "").trim());
  if (!match) return null;
  const mimeType = String(fallbackMimeType || match[1]).trim().toLowerCase() || match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, "");
  if (!base64) return null;
  return {
    mimeType,
    extension: attachmentExtensionFromMimeType(mimeType),
    buffer: Buffer.from(base64, "base64")
  };
}

function attachmentExtensionFromMimeType(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  return mimeType.split("/")[1]?.replace(/[^a-z0-9]+/gi, "").toLowerCase() || "png";
}

function buildAssistantMessages(sessionId, incomingEvents = [], fallbackAt) {
  const messages = [];
  for (const event of incomingEvents || []) {
    const raw = event.raw && typeof event.raw === "object" ? event.raw : {};
    const item = raw.params?.item;
    if ((raw.method || event.type) !== "item/completed" || item?.type !== "agentMessage") continue;
    const text = String(item.text || event.finalMessage || event.text || "").trim();
    if (!text) continue;
    const turnId = String(raw.params?.turnId || raw.params?.turn?.id || "").trim();
    const itemId = String(item.id || "").trim();
    const keySeed = itemId || crypto.createHash("sha1").update(`${turnId}\n${text}`).digest("hex").slice(0, 16);
    messages.push({
      id: crypto.randomUUID(),
      sessionId,
      role: "assistant",
      text,
      commandId: null,
      externalKey: `assistant:${turnId || "turn"}:${keySeed}`,
      createdAt: String(event.at || fallbackAt || nowIso()),
      updatedAt: String(fallbackAt || nowIso())
    });
  }
  return messages;
}

function normalizeSessionAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];

  const normalized = [];
  for (const attachment of attachments) {
    if (normalized.length >= 3) break;
    if (attachment?.type !== "image") continue;
    const url = String(attachment.url || "").trim();
    if (!url.startsWith("data:image/")) continue;
    if (url.length > 10_000_000) continue;
    normalized.push({
      type: "image",
      url,
      name: String(attachment.name || `截图 ${normalized.length + 1}`).trim().slice(0, 120) || `截图 ${normalized.length + 1}`,
      mimeType: String(attachment.mimeType || "").trim().slice(0, 120),
      sizeBytes: clampAttachmentSizeBytes(attachment.sizeBytes)
    });
  }

  return normalized;
}

function clampAttachmentSizeBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.min(Math.round(size), 20 * 1024 * 1024);
}

function sessionTitleFromInput(prompt, attachments = []) {
  const normalizedPrompt = String(prompt || "").split(/\s+/).join(" ").slice(0, 120);
  if (normalizedPrompt) return normalizedPrompt;
  if (attachments.length === 1) return "1 张截图";
  if (attachments.length > 1) return `${attachments.length} 张截图`;
  return "Codex session";
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
      const leaseError =
        command.type === "start"
          ? ""
          : `Desktop agent ${command.leasedBy || "unknown"} stopped renewing this turn; you can continue the same conversation.`;
      db.prepare(`
        UPDATE codex_sessions
        SET status = @status,
            active_turn_id = CASE WHEN @clearActiveTurnId = 1 THEN NULL ELSE active_turn_id END,
            last_error = CASE WHEN @lastError = '' THEN last_error ELSE @lastError END,
            leased_by = NULL,
            lease_expires_at = NULL,
            updated_at = @now
        WHERE id = @sessionId
      `).run({
        sessionId: command.sessionId,
        status: nextStatus,
        clearActiveTurnId: command.type === "start" ? 0 : 1,
        lastError: leaseError,
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

function reclaimExpiredWorkspaceCommandLeases() {
  const now = nowIso();
  db.prepare(`
    UPDATE codex_workspace_commands
    SET status = 'queued',
        leased_by = NULL,
        lease_expires_at = NULL,
        updated_at = @now
    WHERE status = 'leased'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < @now
  `).run({ now });
}

function reclaimExpiredSessionLeases() {
  const now = nowIso();
  const expired = db.prepare(`
    SELECT
      s.id,
      s.status,
      s.app_thread_id AS appThreadId,
      s.leased_by AS leasedBy
    FROM codex_sessions s
    WHERE s.leased_by IS NOT NULL
      AND s.lease_expires_at IS NOT NULL
      AND s.lease_expires_at < ?
      AND NOT EXISTS (
        SELECT 1
        FROM codex_session_commands c
        WHERE c.session_id = s.id
          AND c.status = 'leased'
      )
  `).all(now);

  if (expired.length === 0) return;

  const reclaim = db.transaction(() => {
    for (const session of expired) {
      const resetToQueued = session.status === "starting" && !session.appThreadId;
      const nextStatus = resetToQueued ? "queued" : "active";
      const leaseError =
        nextStatus === "active"
          ? `Desktop agent ${session.leasedBy || "unknown"} stopped renewing this session; the last turn may have been interrupted.`
          : "";

      db.prepare(`
        UPDATE codex_sessions
        SET status = @status,
            active_turn_id = CASE WHEN @clearActiveTurnId = 1 THEN NULL ELSE active_turn_id END,
            last_error = CASE WHEN @lastError = '' THEN last_error ELSE @lastError END,
            leased_by = NULL,
            lease_expires_at = NULL,
            updated_at = @now
        WHERE id = @sessionId
      `).run({
        sessionId: session.id,
        status: nextStatus,
        clearActiveTurnId: nextStatus === "active" ? 1 : 0,
        lastError: leaseError,
        now
      });

      insertSessionEvent.run(
        normalizeSessionEvent(session.id, {
          type: "session.lease.expired",
          text:
            nextStatus === "queued"
              ? `Desktop agent ${session.leasedBy || "unknown"} stopped renewing this session before Codex started; it returned to the queue.`
              : `Desktop agent ${session.leasedBy || "unknown"} stopped renewing this session; the conversation is ready to continue.`
        }, now)
      );
    }
  });

  reclaim();
}

function refreshInteractiveSessionState() {
  reclaimExpiredSessionCommandLeases();
  reclaimExpiredSessionLeases();
  expireOldApprovals();
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

  const attachmentStorageKeys = db.prepare(`
    SELECT storage_key AS storageKey
    FROM codex_session_attachments
    WHERE session_id = ?
  `);
  const remove = db.prepare("DELETE FROM codex_sessions WHERE id = ?");
  const removeMany = db.transaction((sessionIds) => {
    const keys = [];
    for (const id of sessionIds) {
      keys.push(...attachmentStorageKeys.all(id).map((row) => row.storageKey));
      remove.run(id);
    }
    return keys;
  });
  const keys = removeMany(ids);
  cleanupAttachmentStorageKeys(keys);
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
