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
    runtime: { command: "codex", model: "gpt-5.4", unsupportedModels: ["gpt-5.5"] }
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
  assert.deepEqual(onlineStatus.runtime.unsupportedModels, ["gpt-5.5"]);
  assert.equal(onlineStatus.agents.filter((agent) => agent.online).length, 2);
});

test("interactive Codex sessions are scoped to one project", () => {
  store.resetStoreForTest();

  const echoSession = queue.createCodexSession({
    projectId: "echo",
    prompt: "echo 项目的会话"
  });
  const metioSession = queue.createCodexSession({
    projectId: "metio",
    prompt: "metio 项目的会话"
  });

  assert.deepEqual(
    queue.listCodexSessions(10, { projectId: "echo" }).map((session) => session.id),
    [echoSession.id]
  );
  assert.deepEqual(
    queue.listCodexSessions(10, { projectId: "metio" }).map((session) => session.id),
    [metioSession.id]
  );
  assert.throws(
    () =>
      queue.enqueueCodexSessionMessage(echoSession.id, {
        projectId: "metio",
        text: "这条消息不能接到 echo 会话里"
      }),
    /different project/
  );

  const continued = queue.enqueueCodexSessionMessage(echoSession.id, {
    projectId: "echo",
    text: "这条消息属于 echo"
  });
  assert.equal(continued.projectId, "echo");
  assert.equal(continued.messages.filter((message) => message.role === "user").length, 2);
});

test("quick skills include globals and current project skills only", () => {
  store.resetStoreForTest();

  const defaults = queue.listCodexQuickSkills({ projectId: "echo" });
  assert.equal(defaults.some((skill) => skill.id === "builtin.quick-deploy" && skill.scope === "global"), true);

  const globalSkill = queue.createCodexQuickSkill({
    scope: "global",
    title: "检查状态",
    description: "快速查看当前状态",
    prompt: "请检查当前项目状态。",
    mode: "plan"
  });
  const echoSkill = queue.createCodexQuickSkill({
    scope: "project",
    projectId: "echo",
    title: "Echo 发布检查",
    prompt: "请按 Echo 的发布前检查清单执行。",
    requiresSession: true
  });
  queue.createCodexQuickSkill({
    scope: "project",
    projectId: "metio",
    title: "Metio 发布检查",
    prompt: "请按 Metio 的发布前检查清单执行。"
  });

  const echoSkills = queue.listCodexQuickSkills({ projectId: "echo" });
  assert.equal(echoSkills.some((skill) => skill.id === globalSkill.id && skill.scope === "global" && skill.mode === "plan"), true);
  assert.equal(echoSkills.some((skill) => skill.id === echoSkill.id && skill.requiresSession), true);
  assert.equal(echoSkills.some((skill) => skill.projectId === "metio"), false);

  const updated = queue.updateCodexQuickSkill(echoSkill.id, {
    scope: "project",
    projectId: "echo",
    title: "Echo 上线检查",
    prompt: "请执行 Echo 上线检查。"
  });
  assert.equal(updated.title, "Echo 上线检查");

  queue.deleteCodexQuickSkill(globalSkill.id);
  assert.equal(queue.listCodexQuickSkills({ projectId: "echo" }).some((skill) => skill.id === globalSkill.id), false);
});

test("session delta batches append to the visible assistant draft", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "session-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);
  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "write a long answer"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.sessionId, created.id);

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "turn/started",
          text: "Turn started.",
          raw: { method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1" } } }
        },
        {
          type: "item/agentMessage/delta",
          text: "Hello ",
          finalMessage: "Hello ",
          raw: { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", delta: "Hello " } }
        },
        {
          type: "item/agentMessage/delta",
          text: "from ",
          finalMessage: "from ",
          raw: { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", delta: "from " } }
        },
        {
          type: "item/agentMessage/delta",
          text: "Echo",
          finalMessage: "Echo",
          raw: { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", delta: "Echo" } }
        }
      ],
      { agentId: "session-agent" }
    ),
    true
  );

  assert.equal(queue.getCodexSession(created.id).finalMessage, "Hello from Echo");
  const streamSnapshot = queue.getCodexSession(created.id, {
    rawMode: "client",
    maxEvents: 2,
    includeMessages: false
  });
  assert.equal(streamSnapshot.messages, undefined);
  assert.equal(streamSnapshot.events.length, 2);
  assert.equal(streamSnapshot.events[0].raw.params.delta, undefined);
  assert.equal(streamSnapshot.events[1].raw.params.delta, undefined);
  assert.equal(streamSnapshot.finalMessage, "Hello from Echo");
});

test("session token usage events expose official context usage", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "session-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);
  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "measure context"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.sessionId, created.id);

  const tokenUsage = {
    total: {
      totalTokens: 50000,
      inputTokens: 47000,
      cachedInputTokens: 3000,
      outputTokens: 3000,
      reasoningOutputTokens: 900
    },
    last: {
      totalTokens: 32000,
      inputTokens: 30000,
      cachedInputTokens: 1200,
      outputTokens: 2000,
      reasoningOutputTokens: 600
    },
    modelContextWindow: 128000
  };

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "thread/tokenUsage/updated",
          text: "Context usage updated.",
          raw: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thr_usage",
              turnId: "turn_usage",
              tokenUsage
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const detail = queue.getCodexSession(created.id, {
    rawMode: "client",
    includeMessages: false
  });
  assert.equal(detail.contextUsage.source, "codex-app-server");
  assert.equal(detail.contextUsage.threadId, "thr_usage");
  assert.equal(detail.contextUsage.turnId, "turn_usage");
  assert.equal(detail.contextUsage.last.totalTokens, 32000);
  assert.equal(detail.contextUsage.total.totalTokens, 50000);
  assert.equal(detail.contextUsage.modelContextWindow, 128000);

  const usageEvent = detail.events.find((event) => event.type === "thread/tokenUsage/updated");
  assert.equal(usageEvent.raw.params.tokenUsage.last.totalTokens, 32000);
  assert.equal(usageEvent.raw.params.tokenUsage.total.totalTokens, 50000);
  assert.equal(usageEvent.raw.params.tokenUsage.modelContextWindow, 128000);

  const summary = queue.listCodexSessions(10, { projectId: "echo" })[0];
  assert.equal(summary.contextUsage.last.totalTokens, 32000);
});

test("large command outputs are stored as session artifacts", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "artifact-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);
  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "run tests"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.sessionId, created.id);

  const output = `${Array.from({ length: 900 }, (_, index) => `output line ${index}`).join("\n")}\nFAIL test/unit.test.js\nAssertionError: expected true`;
  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/completed",
          text: `pnpm test failed\n${output}`,
          raw: {
            method: "item/completed",
            params: {
              threadId: "thr_artifact",
              turnId: "turn_artifact",
              item: {
                id: "cmd_artifact",
                type: "commandExecution",
                status: "failed",
                command: ["pnpm", "test"],
                aggregatedOutput: output
              }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const detail = queue.getCodexSession(created.id, {
    rawMode: "client",
    includeMessages: false
  });
  const event = detail.events.find((item) => item.type === "item/completed");
  assert.ok(event.id > 0);
  assert.equal(event.text.includes("output line 0"), false);
  assert.equal(event.raw.params.item.aggregatedOutputTruncated, true);
  assert.ok(event.raw.params.item.outputArtifact.id);
  const testSummary = detail.events.find((item) => item.type === "test.summary");
  assert.ok(testSummary.id > event.id);
  assert.equal(testSummary.raw.testSummary.level, "quick");
  assert.equal(testSummary.raw.testSummary.status, "failed");
  assert.equal(testSummary.raw.testSummary.turnId, "turn_artifact");
  assert.equal(testSummary.raw.testSummary.outputArtifact.id, event.raw.params.item.outputArtifact.id);
  assert.equal(testSummary.raw.testSummary.failures.some((line) => /FAIL test\/unit\.test\.js/.test(line)), true);
  assert.equal(detail.artifactCount, 1);
  assert.ok(detail.artifactBytes >= Buffer.byteLength(output));
  assert.equal(detail.metrics.artifactCount, 1);
  assert.equal(detail.metrics.risk, "normal");
  assert.equal(detail.memory.testSummary.status, "failed");
  assert.equal(detail.memory.testSummary.command, "pnpm test");

  const artifact = detail.artifacts[0];
  const content = queue.getCodexSessionArtifactContent(artifact.id);
  assert.equal(content.sizeBytes, Buffer.byteLength(output));
  assert.equal(fs.readFileSync(content.filePath, "utf8"), output);
});

test("fork-summary sessions send compact memory to Codex without changing visible user text", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "fork-summary-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const source = queue.createCodexSession({
    projectId: "demo",
    prompt: "把移动端会话可靠性做完"
  });
  const sourceCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    sourceCommand.id,
    { ok: true, appThreadId: "thr_memory", activeTurnId: "turn_memory", sessionStatus: "running" },
    { agentId: agent.id }
  );
  assert.equal(
    queue.appendCodexSessionEvents(
      source.id,
      [
        {
          type: "item/completed",
          text: "已完成移动端中断和 SSE 恢复。",
          finalMessage: "已完成移动端中断和 SSE 恢复。",
          raw: {
            method: "item/completed",
            params: {
              threadId: "thr_memory",
              turnId: "turn_memory",
              item: { id: "msg_memory", type: "agentMessage", text: "已完成移动端中断和 SSE 恢复。" }
            }
          }
        },
        {
          type: "git.summary",
          text: "Changed this turn: 2",
          raw: {
            source: "desktop-agent",
            method: "git.summary",
            gitSummary: {
              root: process.cwd(),
              branch: "main",
              commit: "abc1234",
              changedFiles: ["public/app/sessions.js", "src/lib/codexStore.js"],
              changedDuringTurn: {
                changedFiles: ["public/app/sessions.js", "src/lib/codexStore.js"],
                commitChanged: false
              }
            }
          }
        },
        {
          type: "turn/completed",
          text: "Turn completed.",
          raw: { method: "turn/completed", params: { threadId: "thr_memory", turn: { id: "turn_memory", status: "completed" } } }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const sourceDetail = queue.getCodexSession(source.id);
  assert.equal(sourceDetail.memory.sourceSessionId, source.id);
  assert.match(sourceDetail.memory.summary, /移动端会话可靠性/);
  assert.equal(sourceDetail.memory.gitSummary.changedThisTurn, true);
  assert.equal(sourceDetail.memory.gitSummary.changedFiles.includes("src/lib/codexStore.js"), true);

  const forked = queue.createCodexSession({
    projectId: "demo",
    prompt: "继续按刚才方向收尾",
    sourceSessionId: source.id,
    threadMode: "fork-summary"
  });
  const forkCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(forkCommand.sessionId, forked.id);
  assert.equal(forkCommand.type, "start");
  assert.equal(forkCommand.payload.threadMode, "fork-summary");
  assert.equal(forkCommand.payload.sourceSessionId, source.id);
  assert.equal(forkCommand.payload.displayText, "继续按刚才方向收尾");
  assert.match(forkCommand.payload.prompt, /旧会话摘要/);
  assert.match(forkCommand.payload.prompt, /移动端会话可靠性/);
  assert.match(forkCommand.payload.prompt, /src\/lib\/codexStore\.js/);
  assert.match(forkCommand.payload.prompt, /当前用户请求：\n继续按刚才方向收尾/);

  const forkDetail = queue.getCodexSession(forked.id);
  assert.equal(forkDetail.messages[0].text, "继续按刚才方向收尾");
  const userEvent = forkDetail.events.find((event) => event.type === "user.message");
  assert.equal(userEvent.raw.threadMode, "fork-summary");
  assert.equal(userEvent.raw.sourceSessionId, source.id);
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
  assert.equal(created.runtime.model, "gpt-5.4");
  assert.equal(created.runtime.reasoningEffort, "high");
  assert.equal(created.runtime.profile, "approve");
  assert.equal(created.runtime.sandbox, "workspace-write");
  assert.equal(created.runtime.approvalPolicy, "on-request");

  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(startCommand.sessionId, created.id);
  assert.equal(startCommand.type, "start");
  assert.equal(startCommand.payload.prompt, "先看一下这个项目");
  assert.equal(startCommand.payload.attachments.length, 1);
  assert.equal(startCommand.payload.attachments[0].type, "image");
  assert.equal(startCommand.payload.attachments[0].downloadPath.startsWith("/api/agent/codex/attachments/"), true);
  assert.equal(startCommand.payload.attachments[0].path, undefined);
  assert.equal(startCommand.runtime.model, "gpt-5.4");
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
  assert.equal(afterMessage.runtime.model, "gpt-5.3-codex");
  assert.equal(afterMessage.runtime.reasoningEffort, "xhigh");
  assert.equal(afterMessage.runtime.profile, "strict");
  assert.equal(afterMessage.runtime.sandbox, "read-only");
  assert.equal(afterMessage.runtime.approvalPolicy, "on-request");

  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.appThreadId, "thr_1");
  assert.equal(messageCommand.payload.text, "继续修复 UI");
  assert.equal(messageCommand.payload.attachments.length, 1);
  assert.equal(messageCommand.payload.attachments[0].type, "image");
  assert.equal(messageCommand.payload.attachments[0].downloadPath.startsWith("/api/agent/codex/attachments/"), true);
  assert.equal(messageCommand.payload.attachments[0].path, undefined);
  assert.equal(messageCommand.runtime.model, "gpt-5.3-codex");
  assert.equal(messageCommand.runtime.reasoningEffort, "xhigh");
  assert.equal(messageCommand.runtime.profile, "strict");
  assert.equal(messageCommand.runtime.sandbox, "read-only");
  assert.equal(messageCommand.runtime.approvalPolicy, "on-request");
});

test("interactive Codex command completion keeps turns that already completed", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "race-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({
    projectId: "demo",
    prompt: "finish quickly"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });

  queue.appendCodexSessionEvents(
    session.id,
    [
      { type: "thread.started", text: "started", appThreadId: "thr_fast", sessionStatus: "active" },
      {
        type: "turn/started",
        text: "Turn started.",
        appThreadId: "thr_fast",
        activeTurnId: "turn_fast",
        sessionStatus: "running",
        raw: { method: "turn/started", params: { threadId: "thr_fast", turn: { id: "turn_fast" } } }
      },
      {
        type: "turn/completed",
        text: "Turn completed.",
        raw: { method: "turn/completed", params: { threadId: "thr_fast", turn: { id: "turn_fast", status: "completed" } } }
      }
    ],
    { agentId: agent.id }
  );

  const beforeCommandComplete = queue.getCodexSession(session.id);
  assert.equal(beforeCommandComplete.status, "active");
  assert.equal(beforeCommandComplete.activeTurnId, null);
  assert.equal(beforeCommandComplete.leasedBy, agent.id);

  assert.equal(
    queue.completeCodexSessionCommand(
      command.id,
      { ok: true, appThreadId: "thr_fast", activeTurnId: "turn_fast", sessionStatus: "running" },
      { agentId: agent.id }
    ),
    true
  );

  const completed = queue.getCodexSession(session.id);
  assert.equal(completed.status, "active");
  assert.equal(completed.activeTurnId, null);
  assert.equal(completed.leasedBy, null);

  db.prepare(`
    UPDATE codex_sessions
    SET status = 'running',
        active_turn_id = 'turn_fast',
        leased_by = ?,
        lease_expires_at = ?
    WHERE id = ?
  `).run(agent.id, new Date(Date.now() + 60000).toISOString(), session.id);
  const reconciled = queue.getCodexSession(session.id);
  assert.equal(reconciled.status, "active");
  assert.equal(reconciled.activeTurnId, null);
  assert.equal(reconciled.leasedBy, null);
  assert.equal(reconciled.events.some((event) => event.type === "session.reconciled"), true);

  const failedSession = queue.createCodexSession({
    projectId: "demo",
    prompt: "fail quickly"
  });
  const failedCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });

  queue.appendCodexSessionEvents(
    failedSession.id,
    [
      { type: "thread.started", text: "started", appThreadId: "thr_failed", sessionStatus: "active" },
      {
        type: "turn/started",
        text: "Turn started.",
        raw: { method: "turn/started", params: { threadId: "thr_failed", turn: { id: "turn_failed" } } }
      },
      {
        type: "turn/completed",
        text: "Turn failed: boom",
        raw: {
          method: "turn/completed",
          params: {
            threadId: "thr_failed",
            turn: {
              id: "turn_failed",
              status: "failed",
              error: { message: "boom" }
            }
          }
        }
      }
    ],
    { agentId: agent.id }
  );

  assert.equal(
    queue.completeCodexSessionCommand(
      failedCommand.id,
      { ok: true, appThreadId: "thr_failed", activeTurnId: "turn_failed", sessionStatus: "running" },
      { agentId: agent.id }
    ),
    true
  );

  const failed = queue.getCodexSession(failedSession.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.activeTurnId, null);
  assert.equal(failed.leasedBy, null);
  assert.match(failed.lastError, /boom/);
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
  assert.equal(startCommand.payload.attachments[0].type, "image");
  assert.equal(startCommand.payload.attachments[0].downloadPath.startsWith("/api/agent/codex/attachments/"), true);

  const session = queue.getCodexSession(created.id);
  assert.equal(session.messages.length >= 1, true);
  assert.equal(session.messages[0].text, "");
  assert.equal(session.messages[0].attachments.length, 1);
  assert.equal(session.messages[0].attachments[0].name, "mobile.png");
});

test("interactive Codex image sessions keep the selected model", async () => {
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
  assert.equal(created.runtime.model, "gpt-5.5");

  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.runtime.model, "gpt-5.5");
  assert.equal(command.payload.attachments[0].type, "image");
  assert.equal(command.payload.attachments[0].downloadPath.startsWith("/api/agent/codex/attachments/"), true);
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

test("interactive Codex full access can be enabled from mobile without extra Echo approval", async () => {
  store.resetStoreForTest();

  queue.updateCodexAgent({
    id: "full-access-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: {
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      allowedPermissionModes: ["strict", "approve", "full"],
      supportedModels: [{ id: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }]
    }
  });

  const created = queue.createCodexSession({
    projectId: "demo",
    prompt: "全权限执行",
    runtime: { model: "gpt-5.5", sandbox: "danger-full-access", approvalPolicy: "never", reasoningEffort: "xhigh", profile: "full" }
  });

  assert.equal(created.runtime.profile, "full");
  assert.equal(created.runtime.sandbox, "danger-full-access");
  assert.equal(created.runtime.approvalPolicy, "never");

  const command = await queue.waitForCodexSessionCommand({
    waitMs: 1000,
    agent: {
      id: "full-access-agent",
      workspaces: [{ id: "demo", path: process.cwd() }],
      runtime: {
        allowedPermissionModes: ["strict", "approve", "full"],
        supportedModels: [{ id: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }]
      }
    }
  });
  assert.equal(command.runtime.profile, "full");
  assert.equal(command.runtime.sandbox, "danger-full-access");
  assert.equal(command.runtime.approvalPolicy, "never");
});

test("interactive Codex sessions drop models not advertised by the desktop app-server", async () => {
  store.resetStoreForTest();

  const agentRuntime = {
    model: "gpt-5.4",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    allowedPermissionModes: ["strict", "approve", "full"],
    supportedModels: [{ id: "gpt-5.4", displayName: "GPT-5.4", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }]
  };
  const agent = {
    id: "supported-model-list-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: agentRuntime
  };
  queue.updateCodexAgent(agent);

  const created = queue.createCodexSession({
    projectId: "demo",
    prompt: "请求不存在的模型",
    runtime: { model: "gpt-5.5", sandbox: "workspace-write", approvalPolicy: "on-request", reasoningEffort: "xhigh", profile: "approve" }
  });
  assert.equal(created.runtime.model, "");
  assert.equal(created.runtime.reasoningEffort, "");
  assert.equal(created.runtime.profile, "approve");

  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.runtime.model, "");
  assert.equal(command.runtime.reasoningEffort, "");
  assert.equal(command.runtime.sandbox, "workspace-write");
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

test("interactive Codex user input waits for mobile answers", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "interaction-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "需要选择模型" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_i" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(command.id, { ok: true, appThreadId: "thr_i", sessionStatus: "running" }, { agentId: agent.id });

  const interaction = queue.createCodexSessionInteraction(
    {
      sessionId: session.id,
      appRequestId: "request-input-1",
      method: "item/tool/requestUserInput",
      kind: "user_input",
      prompt: "选择接下来使用的模型",
      payload: {
        threadId: "thr_i",
        turnId: "turn_i",
        itemId: "call_i",
        questions: [
          {
            id: "model_choice",
            header: "模型",
            question: "选择接下来使用的模型",
            options: [
              { label: "A", description: "保持当前模型" },
              { label: "B", description: "切换到更强模型" }
            ]
          }
        ]
      }
    },
    { agentId: agent.id }
  );
  assert.equal(interaction.status, "pending");

  let detail = queue.getCodexSession(session.id);
  assert.equal(detail.pendingInteractionCount, 1);
  assert.equal(detail.pendingUserInputCount, 1);
  assert.equal(detail.interactions.length, 1);
  assert.equal(detail.events.some((event) => event.type === "interaction.requested"), true);

  const waitPromise = queue.waitForCodexSessionInteraction(interaction.id, { waitMs: 1000, agentId: agent.id });
  const answered = queue.decideCodexSessionInteraction(
    interaction.id,
    { answers: { model_choice: { answers: ["B"] } } },
    { user: { username: "alice" } }
  );
  assert.equal(answered.status, "answered");
  assert.deepEqual(answered.response, { answers: { model_choice: { answers: ["B"] } } });

  const waited = await waitPromise;
  assert.equal(waited.id, interaction.id);
  assert.equal(waited.status, "answered");
  assert.deepEqual(waited.response, { answers: { model_choice: { answers: ["B"] } } });

  detail = queue.getCodexSession(session.id);
  assert.equal(detail.pendingInteractionCount, 0);
  assert.equal(detail.interactions.length, 0);
  assert.equal(detail.events.some((event) => event.type === "interaction.answered"), true);
});

test("interactive Codex user input clears when app-server resolves the request", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "interaction-resolve-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "需要选择方案" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_resolved" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(command.id, { ok: true, appThreadId: "thr_resolved", sessionStatus: "running" }, {
    agentId: agent.id
  });

  const interaction = queue.createCodexSessionInteraction(
    {
      sessionId: session.id,
      appRequestId: "request-input-resolved",
      method: "item/tool/requestUserInput",
      kind: "user_input",
      prompt: "选择下一步方案",
      payload: {
        threadId: "thr_resolved",
        turnId: "turn_resolved",
        itemId: "call_resolved",
        questions: [
          {
            id: "plan_choice",
            header: "方案",
            question: "选择下一步方案",
            options: [
              { label: "A", description: "只整理计划" },
              { label: "B", description: "继续实现" }
            ]
          }
        ]
      }
    },
    { agentId: agent.id }
  );
  assert.equal(interaction.status, "pending");

  const waitPromise = queue.waitForCodexSessionInteraction(interaction.id, {
    waitMs: 1000,
    agentId: agent.id,
    sessionId: session.id
  });
  queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "serverRequest/resolved",
        text: "Request resolved.",
        appThreadId: "thr_resolved",
        raw: {
          method: "serverRequest/resolved",
          params: { threadId: "thr_resolved", requestId: "request-input-resolved" }
        }
      }
    ],
    { agentId: agent.id }
  );

  const waited = await waitPromise;
  assert.equal(waited.id, interaction.id);
  assert.equal(waited.status, "cancelled");
  assert.deepEqual(waited.response, { answers: {} });

  const detail = queue.getCodexSession(session.id);
  assert.equal(detail.pendingInteractionCount, 0);
  assert.equal(detail.interactions.length, 0);
});

test("interactive Codex sessions can request app-server context compaction", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "compact-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "长对话先启动" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_compact" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(startCommand.id, { ok: true, appThreadId: "thr_compact", sessionStatus: "active" }, { agentId: agent.id });

  const queued = queue.compactCodexSession(session.id, { automatic: true, reason: "test-threshold" });
  assert.equal(queued.pendingCommandCount, 1);
  assert.equal(queued.events.some((event) => event.type === "context.compaction.queued"), true);

  const compactCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(compactCommand.type, "compact");
  assert.equal(compactCommand.appThreadId, "thr_compact");
  assert.equal(compactCommand.payload.automatic, true);
  assert.equal(compactCommand.payload.reason, "test-threshold");
  queue.completeCodexSessionCommand(compactCommand.id, { ok: true, appThreadId: "thr_compact", sessionStatus: "running" }, { agentId: agent.id });

  const running = queue.getCodexSession(session.id);
  assert.equal(running.status, "running");
  assert.equal(running.leasedBy, agent.id);

  queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "item/completed",
        text: "Context compaction completed.",
        raw: { method: "item/completed", params: { threadId: "thr_compact", item: { type: "contextCompaction", id: "ctx_1" } } }
      },
      {
        type: "turn/completed",
        text: "Turn completed.",
        raw: { method: "turn/completed", params: { threadId: "thr_compact", turn: { status: "completed" } } }
      }
    ],
    { agentId: agent.id }
  );

  const compacted = queue.getCodexSession(session.id);
  assert.equal(compacted.status, "active");
  assert.equal(compacted.leasedBy, null);
  assert.equal(compacted.events.some((event) => event.raw?.params?.item?.type === "contextCompaction"), true);
});

test("compact command completion releases after compaction events followed by git summary", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "compact-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "启动后压缩" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_compact_race" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_compact_race", sessionStatus: "active" },
    { agentId: agent.id }
  );

  queue.compactCodexSession(session.id, { automatic: false, reason: "manual" });
  const compactCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(compactCommand.type, "compact");

  queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "context.compaction.started",
        text: "Codex context compaction started.",
        appThreadId: "thr_compact_race",
        sessionStatus: "running",
        raw: { method: "thread/compact/start" }
      },
      {
        type: "item/completed",
        text: "Context compaction completed.",
        raw: {
          method: "item/completed",
          params: { threadId: "thr_compact_race", turnId: "turn_compact_race", item: { type: "contextCompaction", id: "ctx_race" } }
        }
      },
      {
        type: "turn/completed",
        text: "Turn completed.",
        raw: { method: "turn/completed", params: { threadId: "thr_compact_race", turn: { id: "turn_compact_race", status: "completed" } } }
      },
      {
        type: "git.summary",
        text: "No git changes.",
        raw: { source: "desktop-agent", gitSummary: { root: process.cwd(), branch: "main", commit: "abc123", changedFiles: [] } }
      }
    ],
    { agentId: agent.id }
  );

  assert.equal(
    queue.completeCodexSessionCommand(
      compactCommand.id,
      { ok: true, appThreadId: "thr_compact_race", sessionStatus: "running" },
      { agentId: agent.id }
    ),
    true
  );

  const completed = queue.getCodexSession(session.id);
  assert.equal(completed.status, "active");
  assert.equal(completed.leasedBy, null);
  assert.equal(completed.activeTurnId, null);
});

test("thread compacted notifications complete compact sessions", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "compact-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "启动后压缩" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_compacted_notice" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_compacted_notice", sessionStatus: "active" },
    { agentId: agent.id }
  );

  queue.compactCodexSession(session.id, { automatic: false, reason: "manual" });
  const compactCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "thread/compacted",
        text: "Context compaction completed.",
        raw: { method: "thread/compacted", params: { threadId: "thr_compacted_notice", turnId: "turn_compacted_notice" } }
      }
    ],
    { agentId: agent.id }
  );

  assert.equal(
    queue.completeCodexSessionCommand(
      compactCommand.id,
      { ok: true, appThreadId: "thr_compacted_notice", sessionStatus: "running" },
      { agentId: agent.id }
    ),
    true
  );

  const completed = queue.getCodexSession(session.id, { rawMode: "client" });
  assert.equal(completed.status, "active");
  assert.equal(completed.leasedBy, null);
  const compactedEvent = completed.events.find((event) => event.type === "thread/compacted");
  assert.equal(compactedEvent.raw.params.threadId, "thr_compacted_notice");
  assert.equal(compactedEvent.raw.params.turnId, "turn_compacted_notice");
});

test("interactive Codex sessions can queue mobile cancellation for the active turn", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "cancel-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({
    projectId: "demo",
    prompt: "run a long task"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_cancel" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(command.id, { ok: true, appThreadId: "thr_cancel", activeTurnId: "turn_cancel", sessionStatus: "running" }, { agentId: agent.id });

  const queuedFollowUp = queue.enqueueCodexSessionMessage(session.id, {
    text: "this queued message should not run before stop"
  });
  assert.equal(queuedFollowUp.pendingCommandCount, 1);

  const cancelled = queue.cancelCodexSession(session.id, { reason: "stop from test" });
  assert.equal(cancelled.pendingCommandCount, 1);
  assert.equal(cancelled.events.some((event) => event.type === "turn.cancel.requested"), true);

  const stopCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(stopCommand.type, "stop");
  assert.equal(stopCommand.appThreadId, "thr_cancel");
  assert.equal(stopCommand.activeTurnId, "turn_cancel");
  assert.equal(stopCommand.payload.reason, "stop from test");

  const nextCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(nextCommand, null);
});

test("plan mode keeps the visible and queued user message clean", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "plan-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const created = queue.createCodexSession({
    projectId: "demo",
    prompt: "分析一下怎么改这个功能",
    mode: "plan"
  });

  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.type, "start");
  assert.equal(command.payload.mode, "plan");
  assert.equal(command.payload.displayText, "分析一下怎么改这个功能");
  assert.equal(command.payload.prompt, "分析一下怎么改这个功能");

  const detail = queue.getCodexSession(created.id);
  assert.equal(detail.messages[0].text, "分析一下怎么改这个功能");
});

test("mobile workspace commands create and advertise managed workspaces", async () => {
  store.resetStoreForTest();

  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-workspace-root-"));
  process.env.ECHO_CODEX_WORKSPACE_ROOT = workspaceRoot;
  const manager = await import("../src/lib/codexWorkspaceManager.js");
  const runner = await import("../src/lib/codexRunner.js");

  const created = queue.createCodexWorkspace({ name: "移动端新工程" });
  assert.equal(created.status, "queued");
  assert.equal(created.payload.name, "移动端新工程");

  const command = await queue.waitForCodexWorkspaceCommand({
    waitMs: 1000,
    agent: {
      id: "workspace-agent",
      workspaces: [],
      runtime: { command: "codex" }
    }
  });
  assert.equal(command.id, created.id);
  assert.equal(command.type, "create");

  const workspace = manager.createManagedWorkspace(command.payload);
  assert.equal(fs.existsSync(workspace.path), true);
  assert.equal(path.dirname(workspace.path), workspaceRoot);

  assert.equal(
    queue.completeCodexWorkspaceCommand(
      command.id,
      { ok: true, workspace },
      {
        agent: {
          id: "workspace-agent",
          workspaces: [workspace],
          runtime: { command: "codex" }
        }
      }
    ),
    true
  );

  const completed = queue.getCodexWorkspaceCommand(command.id);
  assert.equal(completed.status, "done");
  assert.equal(completed.result.workspace.id, workspace.id);
  assert.equal(queue.codexStatus().workspaces.some((item) => item.id === workspace.id), true);
  assert.equal(runner.publicWorkspaces().some((item) => item.id === workspace.id), true);
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
