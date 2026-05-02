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
const artifactStorageDir = path.join(config.dataDir, "codex-artifacts");
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(attachmentStorageDir, { recursive: true });
fs.mkdirSync(artifactStorageDir, { recursive: true });

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

const insertSessionArtifact = db.prepare(`
  INSERT INTO codex_session_artifacts (
    id, session_id, event_id, kind, label, mime_type, size_bytes, sha256, storage_key, created_at
  ) VALUES (
    @id, @sessionId, @eventId, @kind, @label, @mimeType, @sizeBytes, @sha256, @storageKey, @createdAt
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

const insertSessionInteraction = db.prepare(`
  INSERT INTO codex_session_interactions (
    id, session_id, app_request_id, method, kind, status, prompt, payload_json, response_json, created_at, updated_at, requested_by
  ) VALUES (
    @id, @sessionId, @appRequestId, @method, @kind, 'pending', @prompt, @payloadJson, '', @now, @now, @requestedBy
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

const selectLatestSessionContextUsage = db.prepare(`
  SELECT at, raw_json AS rawJson
  FROM codex_session_events
  WHERE session_id = ?
    AND type = 'thread/tokenUsage/updated'
  ORDER BY id DESC
  LIMIT 1
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
  execution_json AS executionJson,
  memory_json AS memoryJson
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

const summarizeSessionInteractionColumns = `
  id,
  session_id AS sessionId,
  app_request_id AS appRequestId,
  method,
  kind,
  status,
  prompt,
  payload_json AS payloadJson,
  response_json AS responseJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  answered_at AS answeredAt,
  answered_by AS answeredBy,
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

const summarizeSessionArtifactColumns = `
  id,
  session_id AS sessionId,
  event_id AS eventId,
  kind,
  label,
  mime_type AS mimeType,
  size_bytes AS sizeBytes,
  sha256,
  storage_key AS storageKey,
  created_at AS createdAt
`;

const summarizeQuickSkillColumns = `
  id,
  scope,
  project_id AS projectId,
  title,
  description,
  prompt,
  mode,
  requires_session AS requiresSession,
  sort_order AS sortOrder,
  created_at AS createdAt,
  updated_at AS updatedAt,
  archived_at AS archivedAt
`;

function defaultQuickDeployPrompt() {
  return [
    "请把当前对话中已经完成且适合发布的代码改动提交、推送，然后把本次结果合入主部署分支并等待部署完成。",
    "",
    "要求：",
    "- 先检查 git status，只提交与本次对话需求相关的文件，不要提交未跟踪的本地预览或附件文件。",
    "- 根据当前仓库和改动类型选择必要且可运行的验证，例如现有测试、语法检查、格式检查或轻量 smoke test；不要强行运行与项目技术栈无关的检查。",
    "- 将本次改动提交在当前结果分支上；如果当前分支不是主部署分支，先把当前分支推送到默认远端。",
    "- 主部署分支默认使用 main；如果仓库明确配置了其他部署分支或当前任务明确指定目标分支，则使用该分支。",
    "- 如果当前分支已经是主部署分支，提交并推送该分支即可；否则先更新远端信息，再把本次结果合入主部署分支并推送主部署分支，以触发基于主部署分支的部署流程。",
    "- 在隔离 worktree 中，主分支可能已被其他工作区占用；可以安全快进时，优先用 refspec 将当前结果提交推送到主部署分支，不要为了切换主分支破坏其他工作区。",
    "- 不要 force push，不要绕过分支保护；如果遇到冲突、非快进、权限限制或必须走 PR/CI 审批，停止并说明需要的人工处理。",
    "- 如果仓库配置了部署流程，等待部署完成并尽量确认远端服务已更新到合并后的主部署分支提交；如果没有可识别的部署流程，说明已完成提交、推送和合并。",
    "- 如果没有可提交改动，不要空提交，直接说明当前状态。",
    "- 最后简短汇报已运行的验证、结果分支 commit、推送目标、合并目标，以及部署或服务状态。"
  ].join("\n");
}

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

export function createSession({ projectId, prompt, attachments, runtime, mode, sourceSessionId, threadMode }) {
  const now = nowIso();
  const sessionId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const normalizedPrompt = String(prompt || "").trim();
  const normalizedProjectId = String(projectId || "").trim();
  const commandMode = normalizeSessionMode(mode);
  const normalizedThreadMode = normalizeThreadMode(threadMode);
  const sourceMemory = normalizedThreadMode === "fork-summary" ? sourceSessionMemory(sourceSessionId, normalizedProjectId) : null;
  const contextPrompt = sourceMemory ? forkSummaryPrompt(normalizedPrompt, sourceMemory) : "";
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
      payloadJson: JSON.stringify({
        messageId,
        mode: commandMode,
        threadMode: sourceMemory ? "fork-summary" : normalizedThreadMode,
        sourceSessionId: sourceMemory?.sourceSessionId || "",
        contextPrompt
      }),
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
        raw: {
          source: "mobile",
          commandId,
          type: "start",
          messageId,
          mode: commandMode,
          threadMode: sourceMemory ? "fork-summary" : normalizedThreadMode,
          sourceSessionId: sourceMemory?.sourceSessionId || "",
          attachments: attachmentRefsFromRows(stagedAttachments)
        }
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

export function getSession(id, options = {}) {
  refreshInteractiveSessionState();

  const session = getSessionSummary(id);
  if (!session) return null;
  const result = {
    ...session,
    events: listSessionEvents(id, {
      maxEvents: options.maxEvents,
      afterEventId: options.afterEventId,
      rawMode: options.rawMode,
      includeRaw: options.includeRaw
    })
  };
  if (options.includeMessages !== false) result.messages = listSessionMessages(id);
  if (options.includeApprovals !== false) result.approvals = listSessionApprovals(id);
  if (options.includeInteractions !== false) result.interactions = listSessionInteractions(id);
  if (options.includeArtifacts !== false) result.artifacts = listSessionArtifacts(id, options.maxArtifacts);
  return result;
}

export function getSessionCommandSessionId(id) {
  return getSessionCommandSummary(id)?.sessionId || "";
}

export function getSessionAttachmentContent(id) {
  const attachment = getSessionAttachment(id);
  if (!attachment) return null;
  return {
    ...attachment,
    filePath: attachmentAbsolutePath(attachment.storageKey)
  };
}

export function getSessionArtifactContent(id) {
  const artifact = getSessionArtifact(id);
  if (!artifact) return null;
  return {
    ...artifact,
    filePath: artifactAbsolutePath(artifact.storageKey)
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
      session.pendingApprovalCount > 0 ||
      session.pendingInteractionCount > 0)
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
      cancelPendingSessionInteractions(sessionId, now, "cancelled");

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
    cancelPendingSessionInteractions(sessionId, now, "cancelled");

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
  const baseIncomingEvents = incomingEvents.slice(0, 80);
  const events = [];
  const eventsForMemory = [...baseIncomingEvents];
  for (const event of baseIncomingEvents) {
    const normalized = normalizeSessionEventForStorage(sessionId, event, now);
    events.push(normalized);
    const storedEvent = {
      ...event,
      at: normalized.row.at,
      text: normalized.row.text,
      raw: parseJson(normalized.row.rawJson, event.raw || {})
    };
    const testSummary = testSummaryFromEvent(storedEvent);
    if (testSummary) {
      const testEvent = {
        at: storedEvent.at,
        type: "test.summary",
        text: formatTestSummaryEventText(testSummary),
        raw: {
          source: "relay",
          method: "test.summary",
          testSummary
        }
      };
      eventsForMemory.push(testEvent);
      events.push(normalizeSessionEventForStorage(sessionId, testEvent, now));
    }
  }
  const update = deriveSessionUpdate(baseIncomingEvents, session);
  const releaseLease = update.releaseLease && !sessionHasLeasedCommand(sessionId);
  const assistantMessages = buildAssistantMessages(sessionId, baseIncomingEvents, now);
  const resolvedServerRequests = serverRequestResolutionsFromEvents(baseIncomingEvents);
  const nextMemory = shouldRefreshSessionMemory(eventsForMemory) ? buildSessionMemory(sessionId, session, eventsForMemory, now) : null;

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
          final_message = COALESCE(@finalMessage, final_message),
          memory_json = COALESCE(@memoryJson, memory_json)
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
      finalMessage: update.finalMessage,
      memoryJson: nextMemory ? JSON.stringify(nextMemory).slice(0, 30000) : null
    });

    for (const event of events) {
      const inserted = insertSessionEvent.run(event.row);
      for (const artifact of event.artifacts) {
        persistSessionArtifact({
          ...artifact,
          sessionId,
          eventId: Number(inserted.lastInsertRowid),
          createdAt: event.row.at
        });
      }
    }
    for (const resolution of resolvedServerRequests) {
      resolvePendingServerRequest(sessionId, resolution.requestId, now);
    }
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
  const completedAsyncWork =
    ok && resultSessionStatus === "running"
      ? sessionCompletedAsyncWorkSince(command.sessionId, command.updatedAt, result.activeTurnId, command.type, result.appThreadId || session.appThreadId)
      : null;
  const sessionStatus = completedAsyncWork ? completedAsyncWork.status : resultSessionStatus;
  const activeTurnId = completedAsyncWork ? null : result.activeTurnId || null;
  const clearActiveTurnId = sessionStatus !== "running";
  const releaseLease = sessionStatus !== "running";
  const lastError =
    completedAsyncWork?.status === "failed"
      ? String(session.lastError || completedAsyncWork.error || error).slice(0, 12000)
      : error;
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
      lastError,
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

export function createSessionInteraction(input = {}, options = {}) {
  const session = getSessionSummary(input.sessionId);
  if (!session) return notFound("Codex session not found.");
  if (!canMutateSession(session, options.agentId)) return false;

  const now = nowIso();
  const interaction = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    appRequestId: String(input.appRequestId || ""),
    method: String(input.method || ""),
    kind: normalizeInteractionKind(input.kind || input.method),
    prompt: String(input.prompt || "").slice(0, 12000),
    payloadJson: JSON.stringify(input.payload || {}).slice(0, 30000),
    requestedBy: normalizeAgentId(options.agentId),
    now
  };

  const create = db.transaction(() => {
    const existing = db.prepare(`
      SELECT ${summarizeSessionInteractionColumns}
      FROM codex_session_interactions
      WHERE session_id = ?
        AND app_request_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(interaction.sessionId, interaction.appRequestId);

    if (existing) return summarizeSessionInteraction(existing);

    insertSessionInteraction.run(interaction);

    insertSessionEvent.run(
      normalizeSessionEvent(interaction.sessionId, {
        type: "interaction.requested",
        text: interaction.prompt || `${interaction.method} requested input.`,
        raw: {
          interactionId: interaction.id,
          appRequestId: interaction.appRequestId,
          method: interaction.method,
          kind: interaction.kind,
          payload: input.payload || {}
        }
      }, now)
    );

    return getSessionInteractionSummary(interaction.id);
  });

  return create();
}

export function decideSessionInteraction(id, input = {}, options = {}) {
  const interaction = getSessionInteractionSummary(id);
  if (!interaction) return notFound("Codex interaction not found.");
  if (input.sessionId && interaction.sessionId !== input.sessionId) return notFound("Codex interaction not found.");
  if (interaction.status !== "pending") return interaction;

  const now = nowIso();
  const status = normalizeInteractionStatus(input.decision);
  const response = buildInteractionResponse(interaction, input, status);
  const answeredBy = String(options.user?.username || options.user?.displayName || "mobile").slice(0, 120);

  const decide = db.transaction(() => {
    db.prepare(`
      UPDATE codex_session_interactions
      SET status = @status,
          response_json = @responseJson,
          answered_at = @now,
          answered_by = @answeredBy,
          updated_at = @now
      WHERE id = @id
        AND status = 'pending'
    `).run({
      id,
      status,
      responseJson: JSON.stringify(response).slice(0, 30000),
      now,
      answeredBy
    });

    insertSessionEvent.run(
      normalizeSessionEvent(interaction.sessionId, {
        type: status === "answered" ? "interaction.answered" : `interaction.${status}`,
        text: interaction.method ? `${interaction.method} ${status}.` : `Interaction ${status}.`,
        raw: { interactionId: interaction.id, response: redactInteractionResponseForEvent(interaction, response) }
      }, now)
    );

    return getSessionInteractionSummary(id);
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

export function waitForSessionInteractionDecision(id, options = {}) {
  expireOldInteractions();
  const interaction = getSessionInteractionSummary(id);
  if (!interaction) return null;
  if (options.agentId && interaction.requestedBy !== normalizeAgentId(options.agentId)) return null;
  return interaction.status === "pending" ? null : interaction;
}

export function listQuickSkills(options = {}) {
  ensureDefaultQuickSkills();
  const projectId = normalizeQuickSkillProjectId(options.projectId);
  const rows = db.prepare(`
    SELECT ${summarizeQuickSkillColumns}
    FROM codex_quick_skills
    WHERE archived_at IS NULL
      AND (
        scope = 'global'
        OR (scope = 'project' AND project_id = @projectId)
      )
    ORDER BY
      CASE scope WHEN 'global' THEN 0 ELSE 1 END,
      sort_order ASC,
      created_at ASC
  `).all({ projectId });
  return rows.map(summarizeQuickSkill);
}

export function createQuickSkill(input = {}) {
  const now = nowIso();
  const skill = normalizeQuickSkillInput(input);
  const sortOrder = Number.isFinite(Number(input.sortOrder))
    ? Math.round(Number(input.sortOrder))
    : nextQuickSkillSortOrder(skill.scope, skill.projectId);
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO codex_quick_skills (
      id, scope, project_id, title, description, prompt, mode, requires_session, sort_order, created_at, updated_at, archived_at
    ) VALUES (
      @id, @scope, @projectId, @title, @description, @prompt, @mode, @requiresSession, @sortOrder, @now, @now, NULL
    )
  `).run({
    id,
    ...skill,
    requiresSession: skill.requiresSession ? 1 : 0,
    sortOrder,
    now
  });

  return getQuickSkill(id);
}

export function updateQuickSkill(id, input = {}) {
  ensureDefaultQuickSkills();
  const existing = getQuickSkill(id);
  if (!existing || existing.archivedAt) return notFound("Quick skill not found.");

  const now = nowIso();
  const next = normalizeQuickSkillInput(input, existing);
  const sortOrder = Number.isFinite(Number(input.sortOrder)) ? Math.round(Number(input.sortOrder)) : existing.sortOrder;
  db.prepare(`
    UPDATE codex_quick_skills
    SET scope = @scope,
        project_id = @projectId,
        title = @title,
        description = @description,
        prompt = @prompt,
        mode = @mode,
        requires_session = @requiresSession,
        sort_order = @sortOrder,
        updated_at = @now
    WHERE id = @id
      AND archived_at IS NULL
  `).run({
    id,
    ...next,
    requiresSession: next.requiresSession ? 1 : 0,
    sortOrder,
    now
  });

  return getQuickSkill(id);
}

export function deleteQuickSkill(id) {
  ensureDefaultQuickSkills();
  const existing = getQuickSkill(id);
  if (!existing || existing.archivedAt) return notFound("Quick skill not found.");

  const now = nowIso();
  db.prepare(`
    UPDATE codex_quick_skills
    SET archived_at = @now,
        updated_at = @now
    WHERE id = @id
      AND archived_at IS NULL
  `).run({ id, now });
  return { ...existing, archivedAt: now };
}

export function resetStoreForTest() {
  db.prepare("DELETE FROM codex_quick_skills").run();
  db.prepare("DELETE FROM codex_workspace_commands").run();
  db.prepare("DELETE FROM codex_session_artifacts").run();
  db.prepare("DELETE FROM codex_session_attachments").run();
  db.prepare("DELETE FROM codex_session_messages").run();
  db.prepare("DELETE FROM codex_session_interactions").run();
  db.prepare("DELETE FROM codex_session_approvals").run();
  db.prepare("DELETE FROM codex_session_events").run();
  db.prepare("DELETE FROM codex_session_commands").run();
  db.prepare("DELETE FROM codex_sessions").run();
  db.prepare("DELETE FROM codex_events").run();
  db.prepare("DELETE FROM codex_jobs").run();
  db.prepare("DELETE FROM codex_agents").run();
  fs.rmSync(attachmentStorageDir, { recursive: true, force: true });
  fs.rmSync(artifactStorageDir, { recursive: true, force: true });
  fs.mkdirSync(attachmentStorageDir, { recursive: true });
  fs.mkdirSync(artifactStorageDir, { recursive: true });
  ensureDefaultQuickSkills();
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
      execution_json TEXT NOT NULL DEFAULT '{}',
      memory_json TEXT NOT NULL DEFAULT '{}'
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

    CREATE TABLE IF NOT EXISTS codex_session_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      event_id INTEGER REFERENCES codex_session_events(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT 'text/plain; charset=utf-8',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      storage_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(storage_key)
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_artifacts_session
      ON codex_session_artifacts(session_id, created_at, id);

    CREATE INDEX IF NOT EXISTS idx_codex_session_artifacts_event
      ON codex_session_artifacts(event_id);

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

    CREATE TABLE IF NOT EXISTS codex_session_interactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      app_request_id TEXT NOT NULL,
      method TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('user_input', 'unknown')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled', 'timed_out')),
      prompt TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      response_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      answered_at TEXT,
      answered_by TEXT NOT NULL DEFAULT '',
      requested_by TEXT NOT NULL DEFAULT '',
      UNIQUE(session_id, app_request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_interactions_session
      ON codex_session_interactions(session_id, status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_interactions_status
      ON codex_session_interactions(status, created_at);

    CREATE TABLE IF NOT EXISTS codex_quick_skills (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
      project_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('execute', 'plan')) DEFAULT 'execute',
      requires_session INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_codex_quick_skills_scope_project_order
      ON codex_quick_skills(scope, project_id, archived_at, sort_order, created_at);
  `);

  ensureColumn("codex_sessions", "archived_at", "TEXT");
  ensureColumn("codex_sessions", "runtime_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("codex_sessions", "execution_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("codex_sessions", "memory_json", "TEXT NOT NULL DEFAULT '{}'");
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

    CREATE INDEX IF NOT EXISTS idx_codex_session_artifacts_session
      ON codex_session_artifacts(session_id, created_at, id);

    CREATE INDEX IF NOT EXISTS idx_codex_session_artifacts_event
      ON codex_session_artifacts(event_id);

    CREATE INDEX IF NOT EXISTS idx_codex_session_approvals_session
      ON codex_session_approvals(session_id, status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_approvals_status
      ON codex_session_approvals(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_interactions_session
      ON codex_session_interactions(session_id, status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_interactions_status
      ON codex_session_interactions(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_quick_skills_scope_project_order
      ON codex_quick_skills(scope, project_id, archived_at, sort_order, created_at);
  `);
  ensureDefaultQuickSkills();
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
      execution_json TEXT NOT NULL DEFAULT '{}',
      memory_json TEXT NOT NULL DEFAULT '{}'
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
      execution_json,
      memory_json
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
      execution_json,
      COALESCE(memory_json, '{}') AS memory_json
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
  if (name === "codex_session_artifacts") {
    return `
      CREATE TABLE codex_session_artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES codex_session_events(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT 'text/plain; charset=utf-8',
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
  if (name === "codex_session_interactions") {
    return `
      CREATE TABLE codex_session_interactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        app_request_id TEXT NOT NULL,
        method TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user_input', 'unknown')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled', 'timed_out')),
        prompt TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        response_json TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        answered_at TEXT,
        answered_by TEXT NOT NULL DEFAULT '',
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
    SELECT id, at, type, text, raw_json AS rawJson
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
  const pendingInteractions = db.prepare("SELECT COUNT(*) AS count FROM codex_session_interactions WHERE status = 'pending'").get().count;
  const archivedSessions = db.prepare("SELECT COUNT(*) AS count FROM codex_sessions WHERE archived_at IS NOT NULL").get().count;

  return {
    queuedCommands,
    activeSessions,
    pendingApprovals,
    pendingInteractions,
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
    SELECT id, at, type, text, raw_json AS rawJson
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
  const pendingInteractionCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_interactions
    WHERE session_id = ?
      AND status = 'pending'
  `).get(row.id).count;
  const pendingUserInputCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_interactions
    WHERE session_id = ?
      AND status = 'pending'
      AND kind = 'user_input'
  `).get(row.id).count;
  const messageCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_messages
    WHERE session_id = ?
  `).get(row.id).count;
  const artifactStats = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS sizeBytes
    FROM codex_session_artifacts
    WHERE session_id = ?
  `).get(row.id);
  const contextUsage = latestSessionContextUsage(row.id);

  return {
    ...row,
    runtime: parseJson(row.runtimeJson, {}),
    execution: parseJson(row.executionJson, {}),
    memory: parseJson(row.memoryJson, {}),
    contextUsage,
    eventCount,
    lastEventId: lastEvent?.id || 0,
    messageCount,
    artifactCount: artifactStats.count || 0,
    artifactBytes: artifactStats.sizeBytes || 0,
    metrics: sessionMetrics(row, {
      eventCount,
      messageCount,
      artifactCount: artifactStats.count || 0,
      artifactBytes: artifactStats.sizeBytes || 0,
      contextUsage
    }),
    pendingCommandCount,
    pendingApprovalCount,
    pendingInteractionCount,
    pendingUserInputCount,
    lastEvent: lastEvent ? parseEvent(lastEvent, { includeRaw: false }) : null
  };
}

function latestSessionContextUsage(sessionId) {
  const row = selectLatestSessionContextUsage.get(sessionId);
  if (!row) return null;
  const raw = parseJson(row.rawJson, null);
  const params = raw?.params && typeof raw.params === "object" ? raw.params : {};
  const tokenUsage = normalizeThreadTokenUsage(params.tokenUsage);
  if (!tokenUsage) return null;
  return {
    source: "codex-app-server",
    at: row.at || "",
    threadId: String(params.threadId || "").slice(0, 200),
    turnId: String(params.turnId || params.turn?.id || "").slice(0, 200),
    ...tokenUsage
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

function summarizeQuickSkill(row) {
  return {
    ...row,
    requiresSession: Boolean(row.requiresSession)
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

function summarizeSessionArtifact(row) {
  return {
    ...row,
    name: row.label,
    downloadPath: `/api/codex/artifacts/${encodeURIComponent(row.id)}`
  };
}

function sessionMetrics(row, stats = {}) {
  const startedAt = row.startedAt || row.createdAt || "";
  const finishedAt = row.completedAt || "";
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(["queued", "starting", "running"].includes(row.status) ? new Date().toISOString() : finishedAt || row.updatedAt || "");
  const elapsedMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : 0;
  const contextPercent = contextUsagePercent(stats.contextUsage);
  const risk = sessionRiskLevel({
    eventCount: stats.eventCount,
    messageCount: stats.messageCount,
    artifactBytes: stats.artifactBytes,
    contextPercent
  });

  return {
    elapsedMs,
    eventCount: stats.eventCount || 0,
    messageCount: stats.messageCount || 0,
    artifactCount: stats.artifactCount || 0,
    artifactBytes: stats.artifactBytes || 0,
    contextPercent,
    risk
  };
}

function contextUsagePercent(contextUsage) {
  const used = Number(contextUsage?.last?.totalTokens || 0);
  const limit = Number(contextUsage?.modelContextWindow || 0);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used <= 0 || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

function sessionRiskLevel({ eventCount = 0, messageCount = 0, artifactBytes = 0, contextPercent = null } = {}) {
  if (Number(contextPercent) >= 85 || Number(eventCount) >= 160 || Number(messageCount) >= 28 || Number(artifactBytes) >= 2 * 1024 * 1024) {
    return "high";
  }
  if (Number(contextPercent) >= 70 || Number(eventCount) >= 100 || Number(messageCount) >= 18 || Number(artifactBytes) >= 768 * 1024) {
    return "warn";
  }
  return "normal";
}

function shouldRefreshSessionMemory(events = []) {
  return events.some((event) => {
    const method = event?.raw?.method || event?.type || "";
    return method === "turn/completed" || method === "thread/compacted" || method === "git.summary" || method === "test.summary";
  });
}

function buildSessionMemory(sessionId, session = {}, events = [], fallbackAt = nowIso()) {
  const messages = listSessionMessages(sessionId)
    .filter((message) => ["user", "assistant"].includes(message.role))
    .filter((message) => String(message.text || "").trim());
  const userMessages = messages.filter((message) => message.role === "user").map((message) => String(message.text || "").trim());
  const assistantMessages = messages.filter((message) => message.role === "assistant").map((message) => String(message.text || "").trim());
  const incomingAssistant = events
    .map((event) => String(event.finalMessage || (event.raw?.params?.item?.type === "agentMessage" ? event.raw.params.item.text : "") || "").trim())
    .filter(Boolean)
    .at(-1);
  const latestAssistant = incomingAssistant || assistantMessages.at(-1) || session.finalMessage || "";
  const gitSummary = latestRawValue(events, "git.summary", "gitSummary");
  const testSummary = latestRawValue(events, "test.summary", "testSummary");
  const plan = events
    .map((event) => event.type === "turn/plan/updated" || event.raw?.params?.item?.type === "plan" ? String(event.text || event.raw?.params?.item?.text || "").trim() : "")
    .filter(Boolean)
    .at(-1) || "";
  const previousMemory = parseJson(session.memoryJson, {});

  const memory = {
    version: 1,
    sourceSessionId: sessionId,
    projectId: session.projectId || "",
    updatedAt: String(fallbackAt || nowIso()),
    title: session.title || userMessages[0] || "Codex session",
    goal: previousMemory.goal || userMessages[0] || session.title || "",
    recentUserRequests: userMessages.slice(-6).map((text) => text.slice(0, 1200)),
    latestAssistantResult: String(latestAssistant || "").slice(0, 2400),
    latestPlan: plan.slice(0, 2000),
    gitSummary: compactMemoryGitSummary(gitSummary),
    testSummary: compactMemoryTestSummary(testSummary),
    notes: []
  };
  memory.summary = formatSessionMemory(memory);
  return memory;
}

function latestRawValue(events, eventType, key) {
  for (const event of [...(events || [])].reverse()) {
    if (event.type !== eventType) continue;
    const raw = event.raw && typeof event.raw === "object" ? event.raw : {};
    if (raw[key]) return raw[key];
    if (raw.method === eventType && raw[key]) return raw[key];
  }
  return null;
}

function compactMemoryGitSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const changedDuringTurn = summary.changedDuringTurn && typeof summary.changedDuringTurn === "object" ? summary.changedDuringTurn : null;
  return {
    branch: String(summary.branch || "").slice(0, 120),
    commit: String(summary.commit || "").slice(0, 80),
    changedFiles: (changedDuringTurn?.changedFiles || summary.changedFiles || []).slice(0, 40),
    changedThisTurn: Boolean(changedDuringTurn),
    worktreeRoot: String(summary.root || "").slice(0, 500)
  };
}

function compactMemoryTestSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  return {
    level: String(summary.level || "").slice(0, 80),
    status: String(summary.status || "").slice(0, 80),
    command: String(summary.command || "").slice(0, 500),
    failures: Array.isArray(summary.failures) ? summary.failures.slice(0, 5) : []
  };
}

function formatSessionMemory(memory) {
  const lines = [];
  if (memory.goal) lines.push(`Goal: ${memory.goal}`);
  if (memory.recentUserRequests?.length) {
    lines.push("Recent user requests:");
    for (const request of memory.recentUserRequests.slice(-4)) lines.push(`- ${request}`);
  }
  if (memory.latestAssistantResult) lines.push(`Latest Codex result: ${memory.latestAssistantResult}`);
  if (memory.latestPlan) lines.push(`Latest plan: ${memory.latestPlan}`);
  if (memory.gitSummary) {
    const files = memory.gitSummary.changedFiles || [];
    lines.push(`Git: ${memory.gitSummary.branch || "unknown"} ${memory.gitSummary.commit || ""}`.trim());
    if (files.length) lines.push(`Changed files: ${files.slice(0, 12).join(", ")}`);
  }
  if (memory.testSummary) {
    lines.push(`Tests: ${memory.testSummary.level || "checks"} ${memory.testSummary.status || ""} ${memory.testSummary.command || ""}`.trim());
    for (const failure of memory.testSummary.failures || []) lines.push(`- ${failure}`);
  }
  return lines.join("\n").slice(0, 8000);
}

function sourceSessionMemory(sourceSessionId, projectId) {
  const sourceId = String(sourceSessionId || "").trim();
  if (!sourceId) return null;
  const source = getSessionSummary(sourceId);
  if (!source || source.projectId !== projectId) return null;
  const memory = source.memory && typeof source.memory === "object" && source.memory.summary ? source.memory : buildSessionMemory(source.id, source, [], nowIso());
  return {
    ...memory,
    sourceSessionId: source.id
  };
}

function forkSummaryPrompt(prompt, memory) {
  return [
    "这是从 Echo 长会话摘要继续的新 Codex thread。完整历史不可见，请只依赖下面摘要和当前用户请求继续；不要要求用户重复上下文，除非摘要不足以安全执行。",
    "",
    "旧会话摘要：",
    memory.summary || formatSessionMemory(memory),
    "",
    "当前用户请求：",
    String(prompt || "").trim() || "（本条消息只有附件或截图，请结合附件继续。）"
  ].join("\n").slice(0, 12000);
}

function getSessionApprovalSummary(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionApprovalColumns}
    FROM codex_session_approvals
    WHERE id = ?
  `).get(id);
  return row ? summarizeSessionApproval(row) : null;
}

function getSessionInteractionSummary(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionInteractionColumns}
    FROM codex_session_interactions
    WHERE id = ?
  `).get(id);
  return row ? summarizeSessionInteraction(row) : null;
}

function summarizeSessionApproval(row) {
  return {
    ...row,
    payload: parseJson(row.payloadJson, {}),
    response: parseJson(row.responseJson, null)
  };
}

function summarizeSessionInteraction(row) {
  return {
    ...row,
    payload: parseJson(row.payloadJson, {}),
    response: parseJson(row.responseJson, null)
  };
}

function listEvents(jobId) {
  return db.prepare(`
    SELECT id, at, type, text, raw_json AS rawJson
    FROM codex_events
    WHERE job_id = ?
    ORDER BY id ASC
  `).all(jobId).map(parseEvent);
}

function listSessionEvents(sessionId, options = {}) {
  const maxEvents = Number(options.maxEvents || 0);
  const afterEventId = Math.max(0, Math.floor(Number(options.afterEventId || 0) || 0));
  if (afterEventId > 0) {
    const limit = Math.min(Math.max(1, Math.round(maxEvents || config.codex.maxEvents)), config.codex.maxEvents);
    return db.prepare(`
      SELECT id, at, type, text, raw_json AS rawJson
      FROM codex_session_events
      WHERE session_id = ?
        AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(sessionId, afterEventId, limit).map((row) => parseEvent(row, options));
  }
  if (maxEvents > 0) {
    return db.prepare(`
      SELECT id, at, type, text, rawJson
      FROM (
        SELECT id, at, type, text, raw_json AS rawJson
        FROM codex_session_events
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
      ORDER BY id ASC
    `).all(sessionId, Math.min(Math.max(1, Math.round(maxEvents)), config.codex.maxEvents)).map((row) => parseEvent(row, options));
  }
  return db.prepare(`
    SELECT id, at, type, text, raw_json AS rawJson
    FROM codex_session_events
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(sessionId).map((row) => parseEvent(row, options));
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

function getSessionArtifact(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionArtifactColumns}
    FROM codex_session_artifacts
    WHERE id = ?
  `).get(id);
  return row ? summarizeSessionArtifact(row) : null;
}

function getQuickSkill(id) {
  const row = db.prepare(`
    SELECT ${summarizeQuickSkillColumns}
    FROM codex_quick_skills
    WHERE id = ?
  `).get(String(id || "").trim());
  return row ? summarizeQuickSkill(row) : null;
}

function ensureDefaultQuickSkills() {
  const now = nowIso();
  db.prepare(`
    INSERT OR IGNORE INTO codex_quick_skills (
      id, scope, project_id, title, description, prompt, mode, requires_session, sort_order, created_at, updated_at, archived_at
    ) VALUES (
      'builtin.quick-deploy',
      'global',
      '',
      '提交推送部署',
      '提交当前结果，合入主部署分支并等待部署完成。',
      @prompt,
      'execute',
      1,
      10,
      @now,
      @now,
      NULL
    )
  `).run({ prompt: defaultQuickDeployPrompt(), now });
}

function nextQuickSkillSortOrder(scope, projectId) {
  const row = db.prepare(`
    SELECT COALESCE(MAX(sort_order), 0) AS maxOrder
    FROM codex_quick_skills
    WHERE scope = ?
      AND project_id = ?
      AND archived_at IS NULL
  `).get(scope, projectId);
  return Number(row?.maxOrder || 0) + 10;
}

function normalizeQuickSkillInput(input = {}, existing = null) {
  const scope = normalizeQuickSkillScope(input.scope ?? existing?.scope ?? "");
  const projectId = scope === "project" ? normalizeQuickSkillProjectId(input.projectId ?? existing?.projectId ?? "") : "";
  if (scope === "project" && !projectId) return badRequest("Project quick skills require a project id.");

  const title = String(input.title ?? existing?.title ?? "").trim().slice(0, 80);
  if (!title) return badRequest("Quick skill title is required.");

  const prompt = String(input.prompt ?? existing?.prompt ?? "").trim().slice(0, 12000);
  if (!prompt) return badRequest("Quick skill prompt is required.");

  return {
    scope,
    projectId,
    title,
    description: String(input.description ?? existing?.description ?? "").trim().slice(0, 240),
    prompt,
    mode: normalizeSessionMode(input.mode ?? existing?.mode ?? "execute"),
    requiresSession:
      input.requiresSession === undefined && existing
        ? Boolean(existing.requiresSession)
        : input.requiresSession === true || input.requiresSession === "true" || input.requiresSession === 1
  };
}

function normalizeQuickSkillScope(value) {
  const scope = String(value || "").trim().toLowerCase();
  return scope === "global" ? "global" : "project";
}

function normalizeQuickSkillProjectId(value) {
  return String(value || "").trim().slice(0, 160);
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

function listSessionArtifacts(sessionId, limit = 30) {
  return db.prepare(`
    SELECT ${summarizeSessionArtifactColumns}
    FROM codex_session_artifacts
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(sessionId, Math.max(1, Math.min(Number(limit) || 30, 100))).map(summarizeSessionArtifact);
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

function listSessionInteractions(sessionId) {
  return db.prepare(`
    SELECT ${summarizeSessionInteractionColumns}
    FROM codex_session_interactions
    WHERE session_id = ?
      AND status = 'pending'
    ORDER BY created_at ASC
  `).all(sessionId).map(summarizeSessionInteraction);
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

function sessionCompletedAsyncWorkSince(sessionId, sinceAt = "", expectedTurnId = "", commandType = "", expectedThreadId = "") {
  const normalizedExpectedTurnId = String(expectedTurnId || "");
  const normalizedExpectedThreadId = String(expectedThreadId || "");
  const allowCompactionCompletion = commandType === "compact";
  const rows = db.prepare(`
    SELECT type, raw_json AS rawJson
    FROM codex_session_events
    WHERE session_id = ?
      AND (? = '' OR at >= ?)
    ORDER BY id DESC
    LIMIT 120
  `).all(sessionId, String(sinceAt || ""), String(sinceAt || ""));

  for (const row of rows) {
    const raw = parseJson(row.rawJson, {});
    const method = raw?.method || row.type || "";
    const params = raw?.params || {};
    const threadId = String(params.threadId || params.thread?.id || params.item?.threadId || "");
    const turnId = String(params.turn?.id || params.turnId || "");
    const itemType = raw?.params?.item?.type || "";
    if (
      method === "turn/completed" &&
      threadMatchesExpected(threadId, normalizedExpectedThreadId) &&
      turnMatchesExpected(turnId, normalizedExpectedTurnId)
    ) {
      const status = params.turn?.status === "failed" ? "failed" : "active";
      return {
        status,
        error: String(params.turn?.error?.message || "").slice(0, 12000)
      };
    }
    if (
      allowCompactionCompletion &&
      threadMatchesExpected(threadId, normalizedExpectedThreadId) &&
      (method === "thread/compacted" || itemType === "contextCompaction")
    ) {
      return { status: "active", error: "" };
    }
  }

  return null;
}

function turnMatchesExpected(turnId, expectedTurnId) {
  return !expectedTurnId || !turnId || turnId === expectedTurnId;
}

function threadMatchesExpected(threadId, expectedThreadId) {
  return !expectedThreadId || !threadId || threadId === expectedThreadId;
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

function cancelPendingSessionInteractions(sessionId, now, answeredBy) {
  const interactions = db.prepare(`
    SELECT ${summarizeSessionInteractionColumns}
    FROM codex_session_interactions
    WHERE session_id = ?
      AND status = 'pending'
  `).all(sessionId).map(summarizeSessionInteraction);

  for (const interaction of interactions) {
    const response = buildInteractionResponse(interaction, {}, "cancelled");
    db.prepare(`
      UPDATE codex_session_interactions
      SET status = 'cancelled',
          response_json = @responseJson,
          answered_at = @now,
          answered_by = @answeredBy,
          updated_at = @now
      WHERE id = @id
        AND status = 'pending'
    `).run({
      id: interaction.id,
      responseJson: JSON.stringify(response),
      now,
      answeredBy
    });

    insertSessionEvent.run(
      normalizeSessionEvent(interaction.sessionId, {
        type: "interaction.cancelled",
        text: `${interaction.method || "Interaction"} cancelled.`,
        raw: { interactionId: interaction.id, response: redactInteractionResponseForEvent(interaction, response) }
      }, now)
    );
  }
}

function serverRequestResolutionsFromEvents(events = []) {
  return events
    .map((event) => {
      const raw = event?.raw || {};
      const method = raw.method || event?.type || "";
      if (method !== "serverRequest/resolved") return null;
      const requestId = raw.params?.requestId;
      if (requestId === undefined || requestId === null) return null;
      return { requestId: String(requestId) };
    })
    .filter(Boolean);
}

function testSummaryFromEvent(event = {}) {
  const raw = event.raw && typeof event.raw === "object" ? event.raw : {};
  const method = raw.method || event.type || "";
  if (method !== "item/completed") return null;
  const item = raw.params?.item;
  if (!item || item.type !== "commandExecution") return null;

  const command = Array.isArray(item.command) ? item.command.join(" ") : String(item.command || "");
  if (!isTestCommand(command)) return null;

  const statusText = String(item.status || "").toLowerCase();
  const output = String(item.aggregatedOutput || "");
  const failed = statusText.includes("fail") || statusText.includes("error") || /(^|\n)\s*(FAIL|Failed|Error:|AssertionError|TimeoutError)\b/.test(output);
  const outputArtifact = item.outputArtifact && typeof item.outputArtifact === "object" ? compactArtifactRef(item.outputArtifact) : null;
  return {
    level: testCommandLevel(command),
    command: command.slice(0, 1000),
    status: failed ? "failed" : statusText.includes("cancel") ? "cancelled" : "passed",
    outputBytes: byteLength(output),
    outputArtifact,
    failures: extractTestFailures(output),
    turnId: String(raw.params?.turnId || raw.params?.turn?.id || "").slice(0, 200)
  };
}

function isTestCommand(command) {
  const text = String(command || "").toLowerCase();
  return /\b(pnpm|npm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck|tsc)\b/.test(text) ||
    /\b(node\s+--test|pytest|vitest|jest|playwright|cypress|ava|mocha|tap)\b/.test(text);
}

function testCommandLevel(command) {
  const text = String(command || "").toLowerCase();
  if (/\b(e2e|playwright|cypress)\b/.test(text)) return "e2e";
  if (/\b(smoke|browser)\b/.test(text)) return "browser-smoke";
  if (/\b(integration|integ)\b/.test(text)) return "integration";
  return "quick";
}

function extractTestFailures(output) {
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const failures = [];
  for (const line of lines) {
    if (!/(FAIL|Failed|Error:|AssertionError|TimeoutError|expected|received|not ok)/i.test(line)) continue;
    failures.push(line.replace(/\b(token|secret|password|api[_-]?key)\b\s*[:=]\s*[^,\s]+/gi, "$1=***").slice(0, 240));
    if (failures.length >= 8) break;
  }
  return failures;
}

function formatTestSummaryEventText(summary) {
  const label = {
    quick: "Quick checks",
    integration: "Integration checks",
    "browser-smoke": "Browser smoke",
    e2e: "E2E"
  }[summary.level] || "Checks";
  const lines = [`${label}: ${summary.status}`, summary.command];
  if (summary.failures?.length) lines.push(...summary.failures.slice(0, 5).map((failure) => `- ${failure}`));
  if (summary.outputArtifact?.downloadPath) lines.push(`Full output: ${summary.outputArtifact.downloadPath}`);
  return lines.filter(Boolean).join("\n");
}

function resolvePendingServerRequest(sessionId, appRequestId, now) {
  const requestId = String(appRequestId || "");
  if (!requestId) return;

  const interactions = db.prepare(`
    SELECT ${summarizeSessionInteractionColumns}
    FROM codex_session_interactions
    WHERE session_id = ?
      AND app_request_id = ?
      AND status = 'pending'
  `).all(sessionId, requestId).map(summarizeSessionInteraction);

  for (const interaction of interactions) {
    const response = buildInteractionResponse(interaction, {}, "cancelled");
    db.prepare(`
      UPDATE codex_session_interactions
      SET status = 'cancelled',
          response_json = @responseJson,
          answered_at = @now,
          answered_by = 'serverRequest/resolved',
          updated_at = @now
      WHERE id = @id
        AND status = 'pending'
    `).run({
      id: interaction.id,
      responseJson: JSON.stringify(response),
      now
    });
  }

  const approvals = db.prepare(`
    SELECT ${summarizeSessionApprovalColumns}
    FROM codex_session_approvals
    WHERE session_id = ?
      AND app_request_id = ?
      AND status = 'pending'
  `).all(sessionId, requestId).map(summarizeSessionApproval);

  for (const approval of approvals) {
    const response = buildApprovalResponse(approval.method, "denied");
    db.prepare(`
      UPDATE codex_session_approvals
      SET status = 'denied',
          response_json = @responseJson,
          decided_at = @now,
          decided_by = 'serverRequest/resolved',
          updated_at = @now
      WHERE id = @id
        AND status = 'pending'
    `).run({
      id: approval.id,
      responseJson: JSON.stringify(response),
      now
    });
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

function normalizeSessionEventForStorage(sessionId, event = {}, fallbackAt) {
  const at = String(event.at || fallbackAt || nowIso());
  const type = String(event.type || "output").slice(0, 120);
  const artifacts = [];
  let text = String(event.text || "");
  let raw = event.raw && typeof event.raw === "object" ? cloneJson(event.raw) : undefined;

  const commandOutput = commandOutputFromRaw(raw);
  if (commandOutput && byteLength(commandOutput) > 4096) {
    const artifact = buildTextArtifact({
      sessionId,
      kind: "command_output",
      label: commandArtifactLabel(raw),
      content: commandOutput,
      createdAt: at
    });
    artifacts.push(artifact);
    const preview = tailPreview(commandOutput, 1600);
    raw = rawWithCommandOutputArtifact(raw, artifact, preview);
    text = commandEventText(raw, preview);
  }

  if (byteLength(text) > 12000) {
    const artifact = buildTextArtifact({
      sessionId,
      kind: "event_text",
      label: `${type} text`,
      content: text,
      createdAt: at
    });
    artifacts.push(artifact);
    text = `${headPreview(text, 800)}\n\n[Full text saved as artifact ${artifact.id}; ${artifact.sizeBytes} bytes]`;
  }

  let rawJson = raw ? JSON.stringify(raw) : null;
  if (rawJson && byteLength(rawJson) > 60000) {
    const artifact = buildTextArtifact({
      sessionId,
      kind: "event_raw",
      label: `${type} raw JSON`,
      content: rawJson,
      mimeType: "application/json",
      createdAt: at
    });
    artifacts.push(artifact);
    rawJson = JSON.stringify({
      method: raw.method || type,
      artifact: artifactRef(artifact),
      truncated: true
    });
  }

  return {
    row: {
      sessionId,
      at,
      type,
      text: text.slice(0, 12000),
      rawJson
    },
    artifacts
  };
}

function commandOutputFromRaw(raw) {
  const item = raw?.params?.item;
  if (!item || item.type !== "commandExecution") return "";
  return String(item.aggregatedOutput || "");
}

function commandArtifactLabel(raw) {
  const item = raw?.params?.item || {};
  const command = compactCommand(item.command);
  const text = Array.isArray(command) ? command.join(" ") : command;
  return text ? `Command output: ${String(text).slice(0, 160)}` : "Command output";
}

function commandEventText(raw, preview) {
  const item = raw?.params?.item || {};
  const command = compactCommand(item.command);
  const commandText = Array.isArray(command) ? command.join(" ") : command || "command";
  const status = item.status || "completed";
  return `${commandText} ${status}\n${preview}`;
}

function rawWithCommandOutputArtifact(raw, artifact, preview) {
  const next = cloneJson(raw || {});
  const item = next?.params?.item;
  if (item && item.type === "commandExecution") {
    item.aggregatedOutput = preview;
    item.aggregatedOutputTruncated = true;
    item.outputArtifact = artifactRef(artifact);
  }
  return next;
}

function buildTextArtifact({ sessionId, kind, label, content, mimeType = "text/plain; charset=utf-8", createdAt }) {
  const id = crypto.randomUUID();
  const buffer = Buffer.from(String(content || ""), "utf8");
  const extension = mimeType.includes("json") ? "json" : "txt";
  return {
    id,
    sessionId,
    eventId: null,
    kind: String(kind || "text").slice(0, 80),
    label: String(label || kind || "artifact").slice(0, 240),
    mimeType,
    sizeBytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    storageKey: artifactStorageKey(sessionId, id, extension),
    createdAt: createdAt || nowIso(),
    content: buffer
  };
}

function persistSessionArtifact(artifact) {
  const absolutePath = artifactAbsolutePath(artifact.storageKey);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, artifact.content, { mode: 0o600 });
  insertSessionArtifact.run({
    id: artifact.id,
    sessionId: artifact.sessionId,
    eventId: artifact.eventId,
    kind: artifact.kind,
    label: artifact.label,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    storageKey: artifact.storageKey,
    createdAt: artifact.createdAt
  });
}

function artifactRef(artifact) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    label: artifact.label,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    downloadPath: `/api/codex/artifacts/${encodeURIComponent(artifact.id)}`
  };
}

function cloneJson(value) {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function headPreview(value, limit) {
  const text = String(value || "");
  return text.length > limit ? text.slice(0, limit).trimEnd() : text;
}

function tailPreview(value, limit) {
  const text = String(value || "");
  return text.length > limit ? text.slice(-limit).trimStart() : text;
}

function parseEvent(row, options = {}) {
  const raw = options.includeRaw === false ? null : parseJson(row.rawJson);
  return {
    id: Number(row.id || 0) || undefined,
    at: row.at,
    type: row.type,
    text: row.text,
    raw: options.rawMode === "client" ? compactClientEventRaw(row.type, raw) : raw
  };
}

function compactClientEventRaw(type, raw) {
  if (!raw || typeof raw !== "object") return null;
  const method = String(raw.method || type || "");
  const params = raw.params && typeof raw.params === "object" ? raw.params : {};
  if (method === "git.summary" || raw.gitSummary) {
    const summary = raw.gitSummary || {};
    const changedFiles = Array.isArray(summary.changedFiles) ? summary.changedFiles : [];
    const changedDuringTurn = summary.changedDuringTurn && typeof summary.changedDuringTurn === "object" ? summary.changedDuringTurn : null;
    return {
      source: raw.source || "",
      gitSummary: {
        root: summary.root || "",
        branch: summary.branch || "",
        commit: summary.commit || "",
        changedDuringTurn: changedDuringTurn
          ? {
              changedFileCount: Array.isArray(changedDuringTurn.changedFiles) ? changedDuringTurn.changedFiles.length : 0,
              changedFiles: Array.isArray(changedDuringTurn.changedFiles) ? changedDuringTurn.changedFiles.slice(0, 20) : [],
              commitChanged: Boolean(changedDuringTurn.commitChanged),
              commitBefore: changedDuringTurn.commitBefore || "",
              commitAfter: changedDuringTurn.commitAfter || ""
            }
          : null,
        changedFileCount: Number.isFinite(Number(summary.changedFileCount)) ? Number(summary.changedFileCount) : changedFiles.length,
        changedFiles: changedFiles.slice(0, 20)
      }
    };
  }
  if (method === "test.summary" || raw.testSummary) {
    const summary = raw.testSummary || {};
    return {
      source: raw.source || "",
      method: "test.summary",
      testSummary: {
        level: summary.level || "",
        status: summary.status || "",
        command: String(summary.command || "").slice(0, 500),
        turnId: String(summary.turnId || "").slice(0, 200),
        outputBytes: Number(summary.outputBytes || 0) || 0,
        outputArtifact: summary.outputArtifact ? compactArtifactRef(summary.outputArtifact) : null,
        failures: Array.isArray(summary.failures) ? summary.failures.slice(0, 5) : []
      }
    };
  }
  if (method === "thread/status/changed") return { method };
  if (method === "thread/tokenUsage/updated") {
    return {
      method,
      params: compactTokenUsageParams(params)
    };
  }
  if (method === "thread/compacted") {
    return {
      method,
      params: {
        threadId: String(params.threadId || "").slice(0, 200),
        turnId: String(params.turnId || params.turn?.id || "").slice(0, 200)
      }
    };
  }
  if (method === "turn/started" || method === "turn/completed") {
    return { method, params: compactTurnParams(params) };
  }
  if (method === "turn/plan/updated") {
    return {
      method,
      params: {
        threadId: params.threadId || "",
        turnId: params.turnId || params.turn?.id || ""
      }
    };
  }
  if (isDeltaEventType(method)) {
    return {
      method,
      params: {
        threadId: params.threadId || "",
        turnId: params.turnId || "",
        itemId: params.itemId || ""
      }
    };
  }
  if (method === "item/completed" || method === "item/started") {
    return { method, params: compactItemParams(params) };
  }
  if (method === "item/commandExecution/requestApproval") {
    return {
      method,
      params: {
        threadId: params.threadId || "",
        turnId: params.turnId || "",
        command: compactCommand(params.command)
      }
    };
  }
  if (method === "thread/start" || method === "thread/resume") {
    return { method };
  }
  if (Array.isArray(raw.attachments)) {
    return {
      attachments: raw.attachments.map(compactClientAttachment).filter(Boolean)
    };
  }
  return { method };
}

function compactTurnParams(params = {}) {
  const turn = params.turn && typeof params.turn === "object" ? params.turn : {};
  return {
    threadId: params.threadId || "",
    turn: {
      id: turn.id || params.turnId || "",
      status: turn.status || "",
      error: turn.error?.message ? { message: String(turn.error.message).slice(0, 1000) } : null
    }
  };
}

function compactItemParams(params = {}) {
  const item = params.item && typeof params.item === "object" ? params.item : {};
  const compactItem = {
    id: item.id || "",
    type: item.type || "",
    status: item.status || ""
  };
  if (item.type === "agentMessage" || item.type === "plan") compactItem.text = String(item.text || "").slice(0, 12000);
  if (item.type === "commandExecution") {
    compactItem.command = compactCommand(item.command);
    compactItem.aggregatedOutput = String(item.aggregatedOutput || "").slice(-1200);
    compactItem.aggregatedOutputTruncated = Boolean(item.aggregatedOutputTruncated);
    if (item.outputArtifact && typeof item.outputArtifact === "object") {
      compactItem.outputArtifact = compactArtifactRef(item.outputArtifact);
    }
  }
  return {
    threadId: params.threadId || "",
    turnId: params.turnId || params.turn?.id || "",
    item: compactItem
  };
}

function compactTokenUsageParams(params = {}) {
  return {
    threadId: String(params.threadId || "").slice(0, 200),
    turnId: String(params.turnId || params.turn?.id || "").slice(0, 200),
    tokenUsage: normalizeThreadTokenUsage(params.tokenUsage)
  };
}

function normalizeThreadTokenUsage(input) {
  if (!input || typeof input !== "object") return null;
  const hasTotal = input.total && typeof input.total === "object";
  const hasLast = input.last && typeof input.last === "object";
  if (!hasTotal && !hasLast) return null;
  const modelContextWindow = tokenCount(input.modelContextWindow ?? input.model_context_window);
  return {
    total: normalizeTokenUsageBreakdown(input.total),
    last: normalizeTokenUsageBreakdown(input.last),
    modelContextWindow: modelContextWindow > 0 ? modelContextWindow : null
  };
}

function normalizeTokenUsageBreakdown(input = {}) {
  const usage = input && typeof input === "object" ? input : {};
  return {
    totalTokens: tokenCount(usage.totalTokens ?? usage.total_tokens),
    inputTokens: tokenCount(usage.inputTokens ?? usage.input_tokens),
    cachedInputTokens: tokenCount(usage.cachedInputTokens ?? usage.cached_input_tokens),
    outputTokens: tokenCount(usage.outputTokens ?? usage.output_tokens),
    reasoningOutputTokens: tokenCount(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens)
  };
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function isDeltaEventType(method) {
  return (
    method === "item/agentMessage/delta" ||
    method === "item/plan/delta" ||
    method === "command/exec/outputDelta" ||
    method === "item/commandExecution/outputDelta"
  );
}

function compactCommand(command) {
  if (Array.isArray(command)) return command.map((part) => String(part || "").slice(0, 200)).slice(0, 40);
  return String(command || "").slice(0, 1000);
}

function compactClientAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") return null;
  return {
    type: attachment.type || "",
    name: attachment.name || "",
    id: attachment.id || "",
    downloadPath: attachment.downloadPath || ""
  };
}

function compactArtifactRef(artifact) {
  return {
    id: String(artifact.id || "").slice(0, 120),
    kind: String(artifact.kind || "").slice(0, 80),
    label: String(artifact.label || "").slice(0, 240),
    sizeBytes: Number(artifact.sizeBytes || 0) || 0,
    downloadPath: String(artifact.downloadPath || "").slice(0, 500)
  };
}

function buildAgentSessionCommand(command) {
  const parsed = summarizeSessionCommand(command);
  const messageId = String(parsed.payload?.messageId || "").trim();
  const message = messageId ? getSessionMessage(messageId) : null;
  const mode = normalizeSessionMode(parsed.payload?.mode);
  const agentText = message ? String(message.text || "").trim() : "";
  const contextPrompt = String(parsed.payload?.contextPrompt || "").trim();
  const commandText = contextPrompt || agentText;
  const payload = {
    ...parsed.payload,
    ...(message
      ? parsed.type === "start"
        ? { prompt: commandText, displayText: message.text, attachments: commandAttachmentsFromMessage(message) }
        : { text: commandText, displayText: message.text, attachments: commandAttachmentsFromMessage(message) }
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

function normalizeThreadMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "fork-summary" || mode === "fork_summary" || mode === "summary") return "fork-summary";
  if (mode === "fresh" || mode === "new") return "fresh";
  return "continue";
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
  let nextFinalMessage = String(session.finalMessage || "");

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
    if (method === "thread/compacted") {
      update.clearActiveTurnId = true;
      update.releaseLease = true;
      update.status = "active";
    }
    if (method === "item/agentMessage/delta" && event.text && !agentMessageCompleted) {
      nextFinalMessage = `${nextFinalMessage}${event.text}`.slice(0, 12000);
      update.finalMessage = nextFinalMessage;
    }
    if (method === "item/completed" && raw.params?.item?.type === "agentMessage") {
      nextFinalMessage = String(raw.params.item.text || "").slice(0, 12000);
      update.finalMessage = nextFinalMessage;
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
    worktreeMode: config.codex.worktreeMode,
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
  if (["queued", "starting", "running", "failed", "closed", "stale", "cancelled"].includes(session.status)) return false;
  return (
    Number(session.pendingCommandCount || 0) === 0 &&
    Number(session.pendingApprovalCount || 0) === 0 &&
    Number(session.pendingInteractionCount || 0) === 0
  );
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

function cleanupArtifactStorageKeys(storageKeys = []) {
  for (const storageKey of storageKeys) {
    if (!storageKey) continue;
    try {
      fs.rmSync(artifactAbsolutePath(storageKey), { force: true });
    } catch {
      // Ignore best-effort cleanup errors for persisted artifact files.
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

function artifactStorageKey(sessionId, artifactId, extension) {
  const safeSessionId = String(sessionId || "session").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const safeArtifactId = String(artifactId || "artifact").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const safeExtension = String(extension || "txt").replace(/[^a-z0-9]+/gi, "").toLowerCase() || "txt";
  return `${safeSessionId}/${safeArtifactId}.${safeExtension}`;
}

function artifactAbsolutePath(storageKey) {
  return path.join(artifactStorageDir, ...String(storageKey || "").split("/"));
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
  reconcileCompletedRunningSessions();
  expireOldApprovals();
  expireOldInteractions();
}

function reconcileCompletedRunningSessions() {
  const rows = db.prepare(`
    SELECT
      s.id,
      s.app_thread_id AS appThreadId,
      s.active_turn_id AS activeTurnId,
      s.last_error AS lastError
    FROM codex_sessions s
    WHERE s.status = 'running'
      AND s.active_turn_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM codex_session_commands c
        WHERE c.session_id = s.id
          AND c.status = 'leased'
      )
  `).all();
  const completedSessions = rows
    .map((session) => ({
      ...session,
      completed: sessionCompletedAsyncWorkSince(session.id, "", session.activeTurnId, "", session.appThreadId)
    }))
    .filter((session) => session.completed);
  if (completedSessions.length === 0) return;

  const now = nowIso();
  const reconcile = db.transaction((sessions) => {
    for (const session of sessions) {
      const lastError =
        session.completed.status === "failed"
          ? String(session.lastError || session.completed.error || "").slice(0, 12000)
          : "";
      const update = db.prepare(`
        UPDATE codex_sessions
        SET status = @status,
            active_turn_id = NULL,
            last_error = @lastError,
            leased_by = NULL,
            lease_expires_at = NULL,
            updated_at = @now
        WHERE id = @sessionId
          AND status = 'running'
          AND active_turn_id = @activeTurnId
      `).run({
        sessionId: session.id,
        activeTurnId: session.activeTurnId,
        status: session.completed.status,
        lastError,
        now
      });
      if (update.changes === 0) continue;
      insertSessionEvent.run(
        normalizeSessionEvent(session.id, {
          type: session.completed.status === "failed" ? "session.reconciled.failed" : "session.reconciled",
          text:
            session.completed.status === "failed"
              ? "Relay reconciled a completed failed Codex turn."
              : "Relay reconciled a completed Codex turn."
        }, now)
      );
    }
  });
  reconcile(completedSessions);
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
  const artifactStorageKeys = db.prepare(`
    SELECT storage_key AS storageKey
    FROM codex_session_artifacts
    WHERE session_id = ?
  `);
  const remove = db.prepare("DELETE FROM codex_sessions WHERE id = ?");
  const removeMany = db.transaction((sessionIds) => {
    const attachmentKeys = [];
    const artifactKeys = [];
    for (const id of sessionIds) {
      attachmentKeys.push(...attachmentStorageKeys.all(id).map((row) => row.storageKey));
      artifactKeys.push(...artifactStorageKeys.all(id).map((row) => row.storageKey));
      remove.run(id);
    }
    return { attachmentKeys, artifactKeys };
  });
  const keys = removeMany(ids);
  cleanupAttachmentStorageKeys(keys.attachmentKeys);
  cleanupArtifactStorageKeys(keys.artifactKeys);
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

function expireOldInteractions() {
  const cutoff = new Date(Date.now() - config.codex.approvalTimeoutMs).toISOString();
  const expired = db.prepare(`
    SELECT ${summarizeSessionInteractionColumns}
    FROM codex_session_interactions
    WHERE status = 'pending'
      AND created_at < ?
  `).all(cutoff).map(summarizeSessionInteraction);

  if (expired.length === 0) return;

  const expire = db.transaction(() => {
    const now = nowIso();
    for (const interaction of expired) {
      const response = buildInteractionResponse(interaction, {}, "timed_out");
      db.prepare(`
        UPDATE codex_session_interactions
        SET status = 'timed_out',
            response_json = @responseJson,
            answered_at = @now,
            answered_by = 'timeout',
            updated_at = @now
        WHERE id = @id
          AND status = 'pending'
      `).run({
        id: interaction.id,
        responseJson: JSON.stringify(response),
        now
      });

      insertSessionEvent.run(
        normalizeSessionEvent(interaction.sessionId, {
          type: "interaction.timed_out",
          text: `${interaction.method || "Interaction"} timed out.`,
          raw: { interactionId: interaction.id, response: redactInteractionResponseForEvent(interaction, response) }
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

function normalizeInteractionKind(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "user_input" || normalized.includes("requestuserinput")) return "user_input";
  return "unknown";
}

function normalizeInteractionStatus(value) {
  const decision = String(value || "").trim().toLowerCase();
  if (["cancel", "cancelled", "canceled", "decline", "denied"].includes(decision)) return "cancelled";
  if (["timeout", "timed_out"].includes(decision)) return "timed_out";
  return "answered";
}

function buildInteractionResponse(interaction, input = {}, status = "answered") {
  if (interaction.kind !== "user_input") return input.response && typeof input.response === "object" ? input.response : {};
  if (status !== "answered") return emptyUserInputResponse();

  const directResponse = input.response && typeof input.response === "object" ? input.response : null;
  const sourceAnswers = input.answers || directResponse?.answers || {};
  return normalizeUserInputResponse(sourceAnswers, interaction.payload?.questions || []);
}

function normalizeUserInputResponse(sourceAnswers = {}, questions = []) {
  const answers = {};
  const source = sourceAnswers && typeof sourceAnswers === "object" ? sourceAnswers : {};
  const knownQuestions = Array.isArray(questions) ? questions : [];
  for (const question of knownQuestions) {
    const id = String(question?.id || "").trim();
    if (!id) continue;
    const values = normalizeUserInputAnswerValues(source[id]);
    if (values.length > 0) answers[id] = { answers: values };
  }

  for (const [id, value] of Object.entries(source)) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId || answers[normalizedId]) continue;
    const values = normalizeUserInputAnswerValues(value);
    if (values.length > 0) answers[normalizedId] = { answers: values };
  }

  return { answers };
}

function normalizeUserInputAnswerValues(value) {
  const rawValues = Array.isArray(value?.answers) ? value.answers : Array.isArray(value) ? value : [value?.answer ?? value?.value ?? value];
  return rawValues
    .map((item) => String(item ?? "").slice(0, 4000))
    .filter((item) => item.length > 0)
    .slice(0, 10);
}

function emptyUserInputResponse() {
  return { answers: {} };
}

function redactInteractionResponseForEvent(interaction, response) {
  if (!interactionHasSecretQuestion(interaction)) return response;
  return { answers: "[redacted]" };
}

function interactionHasSecretQuestion(interaction = {}) {
  const questions = Array.isArray(interaction.payload?.questions) ? interaction.payload.questions : [];
  return questions.some((question) => Boolean(question?.isSecret || question?.is_secret));
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
