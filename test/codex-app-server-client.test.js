import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerClient, buildUserInputs } from "../src/lib/codexAppServerClient.js";
import { buildCodexEnv } from "../src/lib/codexRunner.js";

test("CodexAppServerClient speaks newline-delimited app-server JSON-RPC", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-app-server-client-"));
  const fakeServer = path.join(tempRoot, "fake-codex");

  fs.writeFileSync(
    fakeServer,
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
    const thread = { id: "thr_fake", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1 };
    send({ id: message.id, result: { thread } });
    send({ method: "thread/started", params: { thread } });
    return;
  }
  if (message.method === "turn/start") {
    const turn = { id: "turn_fake", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
    send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: turn.id, itemId: "item_1", delta: "hello" } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { ...turn, status: "completed", completedAt: 2 } } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeServer, 0o755);

  const client = new CodexAppServerClient({ command: fakeServer, cwd: tempRoot, requestTimeoutMs: 1000 });
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));

  await client.start();
  const thread = await client.request("thread/start", {
    cwd: tempRoot,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    experimentalRawEvents: false,
    persistExtendedHistory: false
  });
  const turn = await client.request("turn/start", {
    threadId: thread.thread.id,
    input: buildUserInputs("hi", [{ type: "image", url: "data:image/png;base64,AAAA" }])
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  client.stop();

  assert.equal(thread.thread.id, "thr_fake");
  assert.equal(turn.turn.id, "turn_fake");
  assert.equal(notifications.some((message) => message.method === "thread/started"), true);
  assert.equal(notifications.some((message) => message.method === "item/agentMessage/delta"), true);
  assert.equal(notifications.some((message) => message.method === "turn/completed"), true);
});

test("buildUserInputs supports local image attachments", () => {
  const inputs = buildUserInputs("hi", [{ type: "localImage", path: "/tmp/example.png" }]);
  assert.deepEqual(inputs, [
    { type: "text", text: "hi", text_elements: [] },
    { type: "localImage", path: "/tmp/example.png" }
  ]);
});

test("buildCodexEnv exposes API key stored by codex login --with-api-key", () => {
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-codex-env-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test-from-auth" }), "utf8");

  try {
    process.env.HOME = tempRoot;
    delete process.env.CODEX_HOME;
    delete process.env.OPENAI_API_KEY;

    const env = buildCodexEnv();
    assert.equal(env.CODEX_HOME, codexHome);
    assert.equal(env.OPENAI_API_KEY, "sk-test-from-auth");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
  }
});
