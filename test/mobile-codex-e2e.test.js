import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-mobile-codex-e2e-"));
const tempHome = path.join(tempRoot, "home");
const workspacePath = path.join(tempRoot, "workspace");
const fakeCodexPath = path.join(tempRoot, "fake-codex-app-server");
const capturePath = path.join(tempRoot, "turn-start-capture.json");
const threadCounterPath = path.join(tempRoot, "thread-counter.txt");
const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+KDvY8QAAAABJRU5ErkJggg==";

fs.mkdirSync(tempHome, { recursive: true });
fs.mkdirSync(workspacePath, { recursive: true });
fs.writeFileSync(path.join(workspacePath, "README.md"), "# workspace\n", "utf8");
fs.writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
import fs from "node:fs";
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
    const counterPath = ${JSON.stringify(threadCounterPath)};
    const nextCounter = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, "utf8") : "0") + 1;
    fs.writeFileSync(counterPath, String(nextCounter), "utf8");
    const thread = { id: "thr_mobile_e2e_" + nextCounter, preview: "", ephemeral: false, modelProvider: "openai", createdAt: nextCounter, cwd: message.params.cwd };
    send({ id: message.id, result: { thread } });
    send({ method: "thread/started", params: { thread } });
    return;
  }
  if (message.method === "thread/resume") {
    send({ id: message.id, error: { code: -32004, message: "thread not found: " + message.params.threadId } });
    return;
  }
  if (message.method === "turn/start") {
    const text = message.params.input?.find((item) => item.type === "text")?.text || "";
    const localImagePaths = (message.params.input || []).filter((item) => item.type === "localImage").map((item) => item.path);
    const imageCount = localImagePaths.length;
    fs.writeFileSync(
      ${JSON.stringify(capturePath)},
      JSON.stringify({
        input: message.params.input,
        localImagePaths,
        localImageSizes: localImagePaths.map((filePath) => fs.statSync(filePath).size)
      }, null, 2),
      "utf8"
    );
    const turn = { id: "turn_mobile_e2e", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
    send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: turn.id, itemId: "msg_1", delta: "Fake interactive Codex finished: " } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: turn.id, item: { type: "agentMessage", id: "msg_1", text: "Fake interactive Codex finished: " + text + " [images:" + imageCount + "]" } } });
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
  resetFakeCodexArtifacts();

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
    prompt: "请修复移动端发送任务链路",
    attachments: [{ type: "image", url: `data:image/png;base64,${tinyPngBase64}`, name: "mobile.png", mimeType: "image/png", sizeBytes: 70 }]
  });
  assert.equal(created.status, "queued");

  const command = await queue.waitForCodexSessionCommand({ waitMs: 2000, agent });
  assert.equal(command.sessionId, created.id);
  assert.equal(command.type, "start");

  const result = await runtime.handleCommand(command);
  assert.equal(result.ok, true);
  assert.equal(result.appThreadId, "thr_mobile_e2e_1");
  assert.equal(queue.completeCodexSessionCommand(command.id, result, { agentId: agent.id }), true);

  const completed = await waitForSessionState(() => {
    const session = queue.getCodexSession(created.id);
    return session?.events.some((event) => event.type === "turn/completed") ? session : null;
  });
  assert.equal(completed.status, "active");
  assert.equal(completed.finalMessage, "Fake interactive Codex finished: 请修复移动端发送任务链路 [images:1]");
  assert.equal(completed.events.some((event) => event.type === "thread.started"), true);
  assert.equal(completed.events.some((event) => event.type === "turn/completed"), true);
  assert.equal(completed.messages.length >= 1, true);
  assert.equal(completed.messages[0].attachments.length, 1);
  assert.equal(completed.messages[0].attachments[0].name, "mobile.png");
  assert.equal(queue.listCodexSessions(5)[0].id, created.id);

  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  assert.equal(capture.localImagePaths.length, 1);
  assert.equal(capture.input.some((item) => item.type === "localImage"), true);
  assert.equal(capture.localImageSizes[0] > 0, true);
  assert.equal(capture.localImagePaths[0].startsWith(path.join(tempHome, ".echo-voice", "codex-attachments")), true);
  assert.equal(fs.existsSync(capture.localImagePaths[0]), true);

  runtime.stop();
});

test("mobile relay flow recovers when an old Codex thread disappears", async () => {
  store.resetStoreForTest();
  resetFakeCodexArtifacts();

  const agent = {
    id: "agent-recover",
    workspaces: runner.publicWorkspaces(),
    runtime: runner.publicCodexRuntime()
  };
  const createRuntime = () =>
    new CodexInteractiveRuntime({
      agentId: agent.id,
      onEvents: (id, events) => {
        const ok = queue.appendCodexSessionEvents(id, events, { agentId: agent.id });
        assert.equal(ok, true);
      }
    });
  queue.updateCodexAgent(agent);

  let runtime = createRuntime();
  const created = queue.createCodexSession({
    projectId: "e2e",
    prompt: "先理解这个移动端问题"
  });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 2000, agent });
  const startResult = await runtime.handleCommand(startCommand);
  assert.equal(startResult.appThreadId, "thr_mobile_e2e_1");
  assert.equal(queue.completeCodexSessionCommand(startCommand.id, startResult, { agentId: agent.id }), true);
  await waitForSessionState(() => {
    const session = queue.getCodexSession(created.id);
    return session?.events.some((event) => event.type === "turn/completed") ? session : null;
  });
  runtime.stop();

  runtime = createRuntime();
  queue.enqueueCodexSessionMessage(created.id, { text: "继续修复移动端发送消息报错" });
  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 2000, agent });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.appThreadId, "thr_mobile_e2e_1");
  assert.equal(messageCommand.payload.history.some((message) => message.text.includes("先理解这个移动端问题")), true);

  const messageResult = await runtime.handleCommand(messageCommand);
  assert.equal(messageResult.ok, true);
  assert.equal(messageResult.appThreadId, "thr_mobile_e2e_2");
  assert.equal(queue.completeCodexSessionCommand(messageCommand.id, messageResult, { agentId: agent.id }), true);

  const recovered = await waitForSessionState(() => {
    const session = queue.getCodexSession(created.id);
    return session?.events.some((event) => event.type === "thread.restarted") &&
      session?.events.filter((event) => event.type === "turn/completed").length >= 2
      ? session
      : null;
  });
  assert.equal(recovered.status, "active");
  assert.equal(recovered.appThreadId, "thr_mobile_e2e_2");
  assert.equal(recovered.events.some((event) => event.type === "thread.restarted"), true);

  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  const textInput = capture.input.find((item) => item.type === "text")?.text || "";
  assert.match(textInput, /之前的本地 Codex thread 已失效/);
  assert.match(textInput, /先理解这个移动端问题/);
  assert.match(textInput, /继续修复移动端发送消息报错/);

  runtime.stop();
});

async function waitForSessionState(read, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for Codex session to reach expected state.");
}

function resetFakeCodexArtifacts() {
  fs.rmSync(capturePath, { force: true });
  fs.rmSync(threadCounterPath, { force: true });
}
