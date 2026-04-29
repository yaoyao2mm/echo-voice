import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-mobile-codex-e2e-"));
const tempHome = path.join(tempRoot, "home");
const workspacePath = path.join(tempRoot, "workspace");
const fakeCodexPath = path.join(tempRoot, "fake-codex-app-server");

fs.mkdirSync(tempHome, { recursive: true });
fs.mkdirSync(workspacePath, { recursive: true });
fs.writeFileSync(path.join(workspacePath, "README.md"), "# workspace\n", "utf8");
fs.writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    const thread = { id: "thr_mobile_e2e", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd };
    send({ id: message.id, result: { thread } });
    send({ method: "thread/started", params: { thread } });
    return;
  }
  if (message.method === "turn/start") {
    const text = message.params.input?.[0]?.text || "";
    const turn = { id: "turn_mobile_e2e", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
    send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: turn.id, itemId: "msg_1", delta: "Fake interactive Codex finished: " } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: turn.id, item: { type: "agentMessage", id: "msg_1", text: "Fake interactive Codex finished: " + text } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { ...turn, status: "completed", completedAt: 2 } } });
  }
});
`,
  "utf8"
);
fs.chmodSync(fakeCodexPath, 0o755);

process.env.HOME = tempHome;
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "mobile-e2e-token";
process.env.ECHO_AUTH_ENABLED = "false";
process.env.ECHO_CODEX_COMMAND = fakeCodexPath;
process.env.ECHO_CODEX_WORKSPACES = `e2e=${workspacePath}`;
process.env.ECHO_CODEX_TIMEOUT_MS = "5000";
process.env.ECHO_CODEX_LEASE_MS = "60000";

const store = await import("../src/lib/codexStore.js");
const queue = await import("../src/lib/codexQueue.js");
const runner = await import("../src/lib/codexRunner.js");
const { CodexInteractiveRuntime } = await import("../src/lib/codexInteractiveRunner.js");

test("mobile relay flow runs an interactive Codex session end to end", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "agent-e2e",
    workspaces: runner.publicWorkspaces(),
    runtime: runner.publicCodexRuntime()
  };
  const runtime = new CodexInteractiveRuntime({
    agentId: agent.id,
    onEvents: (id, events) => {
      const ok = queue.appendCodexSessionEvents(id, events, { agentId: agent.id });
      assert.equal(ok, true);
    }
  });
  queue.updateCodexAgent(agent);

  const mobileStatus = queue.codexStatus();
  assert.equal(mobileStatus.agentOnline, true);
  assert.equal(mobileStatus.workspaces.length, 1);
  assert.equal(mobileStatus.workspaces[0].id, "e2e");
  assert.equal(mobileStatus.workspaces[0].path, workspacePath);

  const created = queue.createCodexSession({
    projectId: "e2e",
    prompt: "请修复移动端发送任务链路"
  });
  assert.equal(created.status, "queued");

  const command = await queue.waitForCodexSessionCommand({ waitMs: 2000, agent });
  assert.equal(command.sessionId, created.id);
  assert.equal(command.type, "start");

  const result = await runtime.handleCommand(command);
  assert.equal(result.ok, true);
  assert.equal(result.appThreadId, "thr_mobile_e2e");
  assert.equal(queue.completeCodexSessionCommand(command.id, result, { agentId: agent.id }), true);

  const completed = queue.getCodexSession(created.id);
  assert.equal(completed.status, "active");
  assert.equal(completed.finalMessage, "Fake interactive Codex finished: 请修复移动端发送任务链路");
  assert.equal(completed.events.some((event) => event.type === "thread.started"), true);
  assert.equal(completed.events.some((event) => event.type === "turn/completed"), true);
  assert.equal(queue.listCodexSessions(5)[0].id, created.id);

  runtime.stop();
});
