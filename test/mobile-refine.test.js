import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("mobile Codex refinement can opt out of stale history", async () => {
  const fakeProviderRequests = [];
  const fakeProvider = await listen((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      fakeProviderRequests.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "refined current task" } }] }));
    });
  });

  const echoPort = await freePort();
  const tempHome = path.join(os.tmpdir(), `echo-mobile-refine-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const child = spawn(process.execPath, ["src/server.js", "--relay"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tempHome,
      ECHO_HOST: "127.0.0.1",
      ECHO_PORT: String(echoPort),
      ECHO_MODE: "relay",
      ECHO_TOKEN: "test-token",
      ECHO_AUTH_ENABLED: "false",
      POSTPROCESS_PROVIDER: "openai",
      LLM_BASE_URL: `http://127.0.0.1:${fakeProvider.port}/v1`,
      LLM_API_KEY: "test-key",
      LLM_MODEL: "test-model"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForServer(echoPort);
    await postJson(echoPort, "/api/refine", {
      rawText: "历史污染：provider not provider 不应该进入下一个手机任务",
      mode: "chat"
    });
    await postJson(echoPort, "/api/refine", {
      rawText: "当前手机 Codex 任务",
      mode: "chat",
      contextHint: "手机端 Codex 任务输入",
      includeHistory: false
    });

    const lastRequest = fakeProviderRequests.at(-1);
    const userContent = lastRequest.messages.find((message) => message.role === "user").content;
    assert.equal(userContent.includes("当前手机 Codex 任务"), true);
    assert.equal(userContent.includes("历史污染"), false);
    assert.equal(userContent.includes("provider not provider"), false);
  } finally {
    child.kill();
    fakeProvider.server.close();
  }
});

async function postJson(port, pathName, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Echo-Token": "test-token"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, data.error || `HTTP ${response.status}`);
  return data;
}

async function waitForServer(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/config`);
      if (response.ok) return;
    } catch {
      // Retry until the spawned server is listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Timed out waiting for test relay server.");
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

async function freePort() {
  const { server, port } = await listen((req, res) => res.end("ok"));
  await new Promise((resolve) => server.close(resolve));
  return port;
}
