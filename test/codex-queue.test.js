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

test("agent event and completion writes require the active lease", () => {
  store.resetStoreForTest();

  const created = store.createJob({ projectId: "demo", prompt: "ship it" });
  const running = store.acquireNextJob({
    agentId: "agent-a",
    workspaces: [{ id: "demo", path: process.cwd() }]
  });

  assert.equal(running.id, created.id);
  assert.equal(store.appendEvents(created.id, [{ type: "output", text: "wrong" }]), false);
  assert.equal(store.appendEvents(created.id, [{ type: "output", text: "wrong" }], { agentId: "agent-b" }), false);
  assert.equal(store.appendEvents(created.id, [{ type: "output", text: "right" }], { agentId: "agent-a" }), true);
  assert.equal(store.completeJob(created.id, { ok: true, exitCode: 0 }, { agentId: "agent-b" }), false);
  assert.equal(store.completeJob(created.id, { ok: false, error: "boom" }, { agentId: "agent-a" }), true);

  const completed = store.getJob(created.id);
  assert.equal(completed.status, "failed");
  assert.equal(completed.error, "boom");
  assert.equal(completed.events.some((event) => event.text === "right"), true);
  assert.equal(store.appendEvents(created.id, [{ type: "output", text: "late" }], { agentId: "agent-a" }), false);
});

test("completion status follows ok, errors, and exit codes", () => {
  store.resetStoreForTest();

  const failedByExit = store.createJob({ projectId: "demo", prompt: "fail" });
  store.acquireNextJob({ agentId: "agent-a", workspaces: [{ id: "demo", path: process.cwd() }] });
  assert.equal(store.completeJob(failedByExit.id, { ok: true, exitCode: 1 }, { agentId: "agent-a" }), true);
  assert.equal(store.getJob(failedByExit.id).status, "failed");

  const failedByError = store.createJob({ projectId: "demo", prompt: "error" });
  store.acquireNextJob({ agentId: "agent-a", workspaces: [{ id: "demo", path: process.cwd() }] });
  assert.equal(store.completeJob(failedByError.id, { ok: true, error: "nope" }, { agentId: "agent-a" }), true);
  assert.equal(store.getJob(failedByError.id).status, "failed");

  const completed = store.createJob({ projectId: "demo", prompt: "done" });
  store.acquireNextJob({ agentId: "agent-a", workspaces: [{ id: "demo", path: process.cwd() }] });
  assert.equal(
    store.completeJob(completed.id, { ok: true, exitCode: 0, finalMessage: "done" }, { agentId: "agent-a" }),
    true
  );
  assert.equal(store.getJob(completed.id).status, "completed");
  assert.equal(store.getJob(completed.id).finalMessage, "done");
});

test("agent polling clamps invalid wait values and still returns immediate jobs", async () => {
  store.resetStoreForTest();

  const created = queue.createCodexJob({ projectId: "demo", prompt: "queued" });
  const job = await queue.waitForCodexJob({
    waitMs: "not-a-number",
    agent: {
      id: "agent-a",
      workspaces: [{ id: "demo", path: process.cwd() }]
    }
  });

  assert.equal(job.id, created.id);
});

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

  const created = queue.createCodexSession({ projectId: "demo", prompt: "先看一下这个项目" });
  assert.equal(created.status, "queued");

  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(startCommand.sessionId, created.id);
  assert.equal(startCommand.type, "start");
  assert.equal(startCommand.payload.prompt, "先看一下这个项目");

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

  const afterMessage = queue.enqueueCodexSessionMessage(created.id, { text: "继续修复 UI" });
  assert.equal(afterMessage.pendingCommandCount, 1);

  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.appThreadId, "thr_1");
  assert.equal(messageCommand.payload.text, "继续修复 UI");
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
