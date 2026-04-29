import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "echo-queue-test-"));
process.env.HOME = tempHome;
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_CODEX_LEASE_MS = "60000";

const store = await import("../src/lib/codexStore.js");
const queue = await import("../src/lib/codexQueue.js");

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
