import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "echo-queue-test-"));
process.env.HOME = tempHome;
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_CODEX_LEASE_MS = "60000";

const store = await import("../src/lib/codexStore.js");
const queue = await import("../src/lib/codexQueue.js");
const db = new Database(path.join(tempHome, ".echo-voice", "echo.sqlite"));

test("status advertises only online agent workspaces", () => {
  store.resetStoreForTest();

  queue.updateCodexAgent({
    id: "stale-agent",
    workspaces: [{ id: "e2e", label: "E2E", path: "/tmp/e2e" }],
    runtime: { command: "fake-codex" }
  });
  db.prepare("UPDATE codex_agents SET last_seen_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", "stale-agent");

  const staleStatus = queue.codexStatus();
  assert.equal(staleStatus.agentOnline, false);
  assert.deepEqual(staleStatus.workspaces, []);
  assert.equal(staleStatus.agents[0].online, false);

  queue.updateCodexAgent({
    id: "real-agent-a",
    workspaces: [
      { id: "echo", label: "Echo", path: "/workspace/echo" },
      { id: "metio", label: "Metio", path: "/workspace/metio" }
    ],
    runtime: { command: "codex", model: "gpt-5.4" }
  });
  queue.updateCodexAgent({
    id: "real-agent-b",
    workspaces: [
      { id: "side", label: "Side", path: "/workspace/side" },
      { id: "echo", label: "Echo duplicate", path: "/other/echo" }
    ],
    runtime: { command: "codex", model: "gpt-5.5" }
  });

  const onlineStatus = queue.codexStatus();
  const workspaceIds = onlineStatus.workspaces.map((workspace) => workspace.id).sort();
  assert.equal(onlineStatus.agentOnline, true);
  assert.deepEqual(workspaceIds, ["echo", "metio", "side"]);
  assert.equal(onlineStatus.workspaces.filter((workspace) => workspace.id === "e2e").length, 0);
  assert.equal(onlineStatus.runtime.command, "codex");
  assert.equal(onlineStatus.agents.filter((agent) => agent.online).length, 2);
});

test("interactive Codex sessions lease commands and keep thread state", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "session-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const created = queue.createCodexSession({
    projectId: "demo",
    prompt: "先看一下这个项目",
    attachments: [{ type: "image", url: "data:image/png;base64,AAAA", name: "screen.png", mimeType: "image/png", sizeBytes: 4 }],
    runtime: {
      model: "gpt-5.4",
      reasoningEffort: "high",
      profile: "approve",
      sandbox: "workspace-write",
      approvalPolicy: "on-request"
    }
  });
  assert.equal(created.status, "queued");
  assert.equal(created.runtime.model, "");
  assert.equal(created.runtime.reasoningEffort, "high");
  assert.equal(created.runtime.profile, "approve");
  assert.equal(created.runtime.sandbox, "workspace-write");
  assert.equal(created.runtime.approvalPolicy, "on-request");

  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(startCommand.sessionId, created.id);
  assert.equal(startCommand.type, "start");
  assert.equal(startCommand.payload.prompt, "先看一下这个项目");
  assert.equal(startCommand.payload.attachments.length, 1);
  assert.equal(startCommand.payload.attachments[0].type, "localImage");
  assert.equal(fs.existsSync(startCommand.payload.attachments[0].path), true);
  assert.equal(startCommand.runtime.model, "");
  assert.equal(startCommand.runtime.reasoningEffort, "high");
  assert.equal(startCommand.runtime.profile, "approve");
  assert.equal(startCommand.runtime.sandbox, "workspace-write");
  assert.equal(startCommand.runtime.approvalPolicy, "on-request");

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [{ type: "thread.started", text: "started", appThreadId: "thr_1", sessionStatus: "active" }],
      { agentId: "session-agent" }
    ),
    true
  );
  assert.equal(
    queue.completeCodexSessionCommand(
      startCommand.id,
      { ok: true, appThreadId: "thr_1", activeTurnId: "turn_1", sessionStatus: "running" },
      { agentId: "session-agent" }
    ),
    true
  );

  const running = queue.getCodexSession(created.id);
  assert.equal(running.appThreadId, "thr_1");
  assert.equal(running.activeTurnId, "turn_1");
  assert.equal(running.status, "running");
  assert.equal(running.leasedBy, "session-agent");

  const duringRun = queue.enqueueCodexSessionMessage(created.id, {
    text: "先把这个条件也带上"
  });
  assert.equal(duringRun.status, "running");
  assert.equal(duringRun.pendingCommandCount, 1);

  const steeredCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(steeredCommand.type, "message");
  assert.equal(steeredCommand.appThreadId, "thr_1");
  assert.equal(steeredCommand.activeTurnId, "turn_1");
  assert.equal(steeredCommand.payload.text, "先把这个条件也带上");
  assert.equal(
    queue.completeCodexSessionCommand(
      steeredCommand.id,
      { ok: true, appThreadId: "thr_1", activeTurnId: "turn_1", sessionStatus: "running" },
      { agentId: "session-agent" }
    ),
    true
  );

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/completed",
          text: "ECHO_INTERACTIVE_OK",
          finalMessage: "ECHO_INTERACTIVE_OK",
          raw: {
            method: "item/completed",
            params: { threadId: "thr_1", turnId: "turn_1", item: { type: "agentMessage", text: "ECHO_INTERACTIVE_OK" } }
          }
        }
      ],
      { agentId: "session-agent" }
    ),
    true
  );
  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/agentMessage/delta",
          text: "ECHO",
          finalMessage: "ECHO",
          raw: { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", delta: "ECHO" } }
        }
      ],
      { agentId: "session-agent" }
    ),
    true
  );
  assert.equal(queue.getCodexSession(created.id).finalMessage, "ECHO_INTERACTIVE_OK");

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "turn/completed",
          text: "Turn completed.",
          raw: { method: "turn/completed", params: { threadId: "thr_1", turn: { status: "completed" } } }
        }
      ],
      { agentId: "session-agent" }
    ),
    true
  );
  assert.equal(queue.getCodexSession(created.id).status, "active");
  assert.equal(queue.getCodexSession(created.id).activeTurnId, null);
  assert.equal(queue.getCodexSession(created.id).leasedBy, null);

  const afterMessage = queue.enqueueCodexSessionMessage(created.id, {
    text: "继续修复 UI",
    attachments: [{ type: "image", url: "data:image/png;base64,BBBB", name: "detail.png", mimeType: "image/png", sizeBytes: 4 }],
    runtime: {
      model: "gpt-5.3-codex",
      reasoningEffort: "xhigh",
      profile: "strict",
      sandbox: "read-only",
      approvalPolicy: "on-request"
    }
  });
  assert.equal(afterMessage.pendingCommandCount, 1);
  assert.equal(afterMessage.runtime.model, "");
  assert.equal(afterMessage.runtime.reasoningEffort, "xhigh");
  assert.equal(afterMessage.runtime.profile, "strict");
  assert.equal(afterMessage.runtime.sandbox, "read-only");
  assert.equal(afterMessage.runtime.approvalPolicy, "on-request");

  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.appThreadId, "thr_1");
  assert.equal(messageCommand.payload.text, "继续修复 UI");
  assert.equal(messageCommand.payload.attachments.length, 1);
  assert.equal(messageCommand.payload.attachments[0].type, "localImage");
  assert.equal(fs.existsSync(messageCommand.payload.attachments[0].path), true);
  assert.equal(messageCommand.runtime.model, "");
  assert.equal(messageCommand.runtime.reasoningEffort, "xhigh");
  assert.equal(messageCommand.runtime.profile, "strict");
  assert.equal(messageCommand.runtime.sandbox, "read-only");
  assert.equal(messageCommand.runtime.approvalPolicy, "on-request");
});

test("interactive Codex sessions can start from screenshots only", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "image-only-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const created = queue.createCodexSession({
    projectId: "demo",
    attachments: [{ type: "image", url: "data:image/png;base64,CCCC", name: "mobile.png", mimeType: "image/png", sizeBytes: 4 }]
  });
  assert.equal(created.title, "1 张截图");

  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(startCommand.type, "start");
  assert.equal(startCommand.payload.prompt, "");
  assert.equal(startCommand.payload.attachments.length, 1);
  assert.equal(startCommand.payload.attachments[0].type, "localImage");

  const session = queue.getCodexSession(created.id);
  assert.equal(session.messages.length >= 1, true);
  assert.equal(session.messages[0].text, "");
  assert.equal(session.messages[0].attachments.length, 1);
  assert.equal(session.messages[0].attachments[0].name, "mobile.png");
});

test("interactive Codex image sessions fall back away from unsupported models", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "image-fallback-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const created = queue.createCodexSession({
    projectId: "demo",
    prompt: "看图说话",
    attachments: [{ type: "image", url: "data:image/png;base64,AAAA", name: "vision.png", mimeType: "image/png", sizeBytes: 4 }],
    runtime: { model: "gpt-5.5", sandbox: "danger-full-access", approvalPolicy: "never", reasoningEffort: "xhigh", profile: "full" }
  });
  assert.equal(created.runtime.model, "");

  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.runtime.model, "");
  assert.equal(command.payload.attachments[0].type, "localImage");
});

test("interactive Codex sessions avoid models that require a newer CLI", async () => {
  store.resetStoreForTest();
  const previousUnsupportedModels = process.env.ECHO_CODEX_UNSUPPORTED_MODELS;
  process.env.ECHO_CODEX_UNSUPPORTED_MODELS = "gpt-5.5";
  try {
    const agent = {
      id: "model-fallback-agent",
      workspaces: [{ id: "demo", path: process.cwd() }]
    };

    const created = queue.createCodexSession({
      projectId: "demo",
      prompt: "现在如何了？",
      runtime: { model: "gpt-5.5", sandbox: "danger-full-access", approvalPolicy: "never", reasoningEffort: "xhigh", profile: "full" }
    });
    assert.equal(created.runtime.model, "");
    assert.equal(created.runtime.sandbox, "danger-full-access");

    const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
    assert.equal(command.runtime.model, "");
    assert.equal(command.payload.prompt, "现在如何了？");
  } finally {
    if (previousUnsupportedModels === undefined) delete process.env.ECHO_CODEX_UNSUPPORTED_MODELS;
    else process.env.ECHO_CODEX_UNSUPPORTED_MODELS = previousUnsupportedModels;
  }
});

test("interactive Codex sessions keep GPT-5.5 when the desktop CLI supports it", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "supported-model-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const created = queue.createCodexSession({
    projectId: "demo",
    prompt: "使用新模型",
    runtime: { model: "gpt-5.5", sandbox: "danger-full-access", approvalPolicy: "never", reasoningEffort: "xhigh", profile: "full" }
  });
  assert.equal(created.runtime.model, "gpt-5.5");

  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.runtime.model, "gpt-5.5");
  assert.equal(command.payload.prompt, "使用新模型");
});

test("interactive Codex sessions recover expired running leases instead of looking stuck forever", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "expired-session-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "看一下这个处理中会话" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(
    session.id,
    [{ type: "thread.started", text: "started", appThreadId: "thr_expired", sessionStatus: "active" }],
    { agentId: agent.id }
  );
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_expired", activeTurnId: "turn_expired", sessionStatus: "running" },
    { agentId: agent.id }
  );

  db.prepare("UPDATE codex_sessions SET lease_expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", session.id);

  const recovered = queue.getCodexSession(session.id);
  assert.equal(recovered.status, "active");
  assert.equal(recovered.activeTurnId, null);
  assert.equal(recovered.leasedBy, null);
  assert.match(recovered.lastError, /stopped renewing this session/i);
  assert.equal(recovered.events.some((event) => event.type === "session.lease.expired"), true);
});

test("interactive Codex sessions can continue after recoverable app-server failures", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "recoverable-failure-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "第一条消息" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_lost" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(startCommand.id, { ok: false, error: "thread not found: thr_lost" }, { agentId: agent.id });

  const failed = queue.getCodexSession(session.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.lastError, /thread not found/);

  const continued = queue.enqueueCodexSessionMessage(session.id, { text: "继续这条会话" });
  assert.equal(continued.status, "active");
  assert.equal(continued.lastError, "");
  assert.equal(continued.pendingCommandCount, 1);

  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.appThreadId, "thr_lost");
  assert.equal(messageCommand.payload.text, "继续这条会话");
  assert.equal(messageCommand.payload.history.some((message) => message.text === "第一条消息"), true);
});

test("interactive Codex approvals wait for mobile decisions", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "approval-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "需要跑测试" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_a" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(command.id, { ok: true, appThreadId: "thr_a", sessionStatus: "running" }, { agentId: agent.id });

  const approval = queue.createCodexSessionApproval(
    {
      sessionId: session.id,
      appRequestId: "request-1",
      method: "item/commandExecution/requestApproval",
      prompt: "Codex requested command approval: pnpm test",
      payload: { command: "pnpm test", cwd: process.cwd() }
    },
    { agentId: agent.id }
  );
  assert.equal(approval.status, "pending");

  const waitPromise = queue.waitForCodexSessionApproval(approval.id, { waitMs: 1000, agentId: agent.id });
  const decided = queue.decideCodexSessionApproval(approval.id, { decision: "approved" }, { user: { username: "alice" } });
  assert.equal(decided.status, "approved");
  assert.deepEqual(decided.response, { decision: "accept" });

  const waited = await waitPromise;
  assert.equal(waited.id, approval.id);
  assert.equal(waited.status, "approved");
  assert.deepEqual(waited.response, { decision: "accept" });

  const detail = queue.getCodexSession(session.id);
  assert.equal(detail.pendingApprovalCount, 0);
  assert.equal(detail.approvals.length, 0);
  assert.equal(detail.events.some((event) => event.type === "approval.approved"), true);
});

test("interactive Codex sessions can be archived and restored", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "archive-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "整理历史会话" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_archive" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(command.id, { ok: true, appThreadId: "thr_archive", sessionStatus: "active" }, { agentId: agent.id });

  assert.equal(queue.listCodexSessions(10).some((item) => item.id === session.id), true);
  const archived = queue.archiveCodexSession(session.id, { archived: true });
  assert.equal(Boolean(archived.archivedAt), true);
  assert.equal(queue.listCodexSessions(10).some((item) => item.id === session.id), false);
  assert.equal(queue.listCodexSessions(10, { archived: true }).some((item) => item.id === session.id), true);

  const restored = queue.archiveCodexSession(session.id, { archived: false });
  assert.equal(restored.archivedAt, null);
  assert.equal(queue.listCodexSessions(10).some((item) => item.id === session.id), true);
});
