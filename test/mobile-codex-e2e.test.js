import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-mobile-codex-e2e-"));
const tempHome = path.join(tempRoot, "home");
const workspacePath = path.join(tempRoot, "workspace");
const fakeCodexPath = path.join(tempRoot, "fake-codex");

fs.mkdirSync(tempHome, { recursive: true });
fs.mkdirSync(workspacePath, { recursive: true });
fs.writeFileSync(path.join(workspacePath, "README.md"), "# workspace\n", "utf8");
fs.writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", async () => {
  const args = process.argv.slice(2);
  const cwdIndex = args.indexOf("-C");
  const workspace = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
  console.log(JSON.stringify({ type: "thread.started", text: "[thread.started]" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "tool_result", text: "workspace=" + workspace } }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Fake Codex finished: " + prompt.trim() } }));
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

test("mobile relay flow can queue and complete a Codex task end to end", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "agent-e2e",
    workspaces: runner.publicWorkspaces(),
    runtime: runner.publicCodexRuntime()
  };

  const agentJobPromise = queue.waitForCodexJob({
    waitMs: 2000,
    agent
  });

  const mobileStatus = queue.codexStatus();
  assert.equal(mobileStatus.agentOnline, true);
  assert.equal(mobileStatus.workspaces.length, 1);
  assert.equal(mobileStatus.workspaces[0].id, "e2e");
  assert.equal(mobileStatus.workspaces[0].path, workspacePath);

  const queued = queue.createCodexJob({
    projectId: "e2e",
    prompt: "请修复移动端发送任务链路"
  });

  assert.equal(queued.status, "queued");
  assert.equal(queued.projectId, "e2e");

  const leased = await agentJobPromise;
  assert.equal(leased.id, queued.id);
  assert.equal(leased.projectId, "e2e");

  const streamedEvents = [];
  const result = await runner.runCodexJob(leased, {
    onEvents: async (events) => {
      streamedEvents.push(...events);
      const ok = queue.appendCodexEvents(leased.id, events, { agentId: agent.id });
      assert.equal(ok, true);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.finalMessage, "Fake Codex finished: 请修复移动端发送任务链路");

  const completedOk = queue.completeCodexJob(leased.id, result, { agentId: agent.id });
  assert.equal(completedOk, true);

  const completed = queue.getCodexJob(leased.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.finalMessage, "Fake Codex finished: 请修复移动端发送任务链路");
  assert.equal(completed.events.some((event) => event.type === "lease.acquired"), true);
  assert.equal(completed.events.some((event) => event.type === "runner"), true);
  assert.equal(completed.events.some((event) => event.type === "job.completed"), true);
  assert.equal(completed.events.some((event) => event.text.includes("workspace=" + workspacePath)), true);
  assert.equal(streamedEvents.some((event) => event.type === "item.completed"), true);

  const jobs = queue.listCodexJobs(5);
  assert.equal(jobs[0].id, queued.id);
  assert.equal(jobs[0].status, "completed");
});
