import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Codex session SSE streams partial updates after the initial snapshot", async (t) => {
  const port = await freePort();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "echo-codex-sse-"));
  const token = "sse-test-token";
  const agentId = "sse-test-agent";
  const baseUrl = `http://127.0.0.1:${port}`;
  let stderr = "";

  const child = spawn(process.execPath, ["src/server.js", "--relay"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tempHome,
      ECHO_HOST: "127.0.0.1",
      ECHO_PORT: String(port),
      ECHO_MODE: "relay",
      ECHO_PUBLIC_URL: baseUrl,
      ECHO_TOKEN: token,
      ECHO_AUTH_ENABLED: "false",
      ECHO_CODEX_WORKSPACES: `echo=${process.cwd()}`
    },
    stdio: ["ignore", "ignore", "pipe"]
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  t.after(() => {
    child.kill();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, () => stderr);

  const created = await apiJson(baseUrl, token, "/api/codex/sessions", {
    method: "POST",
    body: {
      projectId: "echo",
      prompt: "SSE direct update test",
      runtime: {}
    }
  });
  const sessionId = created.session.id;

  const leased = await apiJson(baseUrl, token, "/api/agent/codex/sessions/next?wait=1000", {
    method: "POST",
    body: {
      agentId,
      workspaces: [{ id: "echo", label: "Echo", path: process.cwd() }],
      runtime: { command: "fake-codex" }
    }
  });
  assert.equal(leased.command?.sessionId, sessionId);

  const ticket = await apiJson(baseUrl, token, `/api/codex/sessions/${encodeURIComponent(sessionId)}/events-ticket`, {
    method: "POST",
    body: {}
  });
  assert.ok(ticket.ticket);

  const stream = await fetch(`${baseUrl}/api/codex/sessions/${encodeURIComponent(sessionId)}/events?ticket=${encodeURIComponent(ticket.ticket)}`);
  assert.equal(stream.ok, true);
  assert.equal(stream.headers.get("content-type")?.includes("text/event-stream"), true);

  const reader = stream.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));

  const initial = await readSseSession(reader);
  assert.equal(initial.partial, false);
  assert.equal(initial.session.id, sessionId);

  const appended = await apiJson(baseUrl, token, "/api/agent/codex/sessions/events", {
    method: "POST",
    body: {
      id: sessionId,
      agentId,
      events: [
        {
          type: "turn/started",
          text: "Codex turn started.",
          appThreadId: "thr_sse_test",
          activeTurnId: "turn_sse_test",
          sessionStatus: "running",
          raw: {
            method: "turn/started",
            params: {
              threadId: "thr_sse_test",
              turn: { id: "turn_sse_test" }
            }
          }
        }
      ]
    }
  });
  assert.equal(appended.ok, true);

  const update = await readSseSession(reader);
  assert.equal(update.partial, true);
  assert.equal(update.session.id, sessionId);
  assert.equal(update.session.status, "running");
  assert.equal(update.session.events.some((event) => event.type === "turn/started"), true);
  assert.ok(update.lastEventId > 0);
  assert.ok(update.session.events.every((event) => event.id > 0));

  await reader.cancel().catch(() => {});

  const resumedEvent = await apiJson(baseUrl, token, "/api/agent/codex/sessions/events", {
    method: "POST",
    body: {
      id: sessionId,
      agentId,
      events: [
        {
          type: "item/agentMessage/delta",
          text: "resumed",
          finalMessage: "resumed",
          raw: {
            method: "item/agentMessage/delta",
            params: {
              threadId: "thr_sse_test",
              turnId: "turn_sse_test",
              itemId: "msg_resume",
              delta: "resumed"
            }
          }
        }
      ]
    }
  });
  assert.equal(resumedEvent.ok, true);

  const resumeTicket = await apiJson(baseUrl, token, `/api/codex/sessions/${encodeURIComponent(sessionId)}/events-ticket`, {
    method: "POST",
    body: {}
  });
  const resumedStream = await fetch(
    `${baseUrl}/api/codex/sessions/${encodeURIComponent(sessionId)}/events?ticket=${encodeURIComponent(resumeTicket.ticket)}&after=${encodeURIComponent(update.lastEventId)}`
  );
  assert.equal(resumedStream.ok, true);
  const resumedReader = resumedStream.body.getReader();
  t.after(() => resumedReader.cancel().catch(() => {}));

  const resumed = await readSseSession(resumedReader);
  assert.equal(resumed.partial, true);
  assert.equal(resumed.recovered, true);
  assert.equal(resumed.session.id, sessionId);
  assert.equal(resumed.session.events.length, 1);
  assert.equal(resumed.session.events[0].type, "item/agentMessage/delta");
  assert.ok(resumed.session.events[0].id > update.lastEventId);
});

async function apiJson(baseUrl, token, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Echo-Token": token
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, data.error || `HTTP ${response.status}`);
  return data;
}

async function waitForServer(baseUrl, stderrText) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/config`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(80);
  }
  throw new Error(`Timed out waiting for test relay server. ${stderrText()}`);
}

async function readSseSession(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      delay(500).then(() => ({ timeout: true }))
    ]);
    if (result.timeout) continue;
    if (result.done) break;

    buffer += decoder.decode(result.value, { stream: true });
    const parsed = parseSseBlocks(buffer);
    buffer = parsed.remainder;
    const sessionEvent = parsed.events.find((event) => event.event === "session");
    if (sessionEvent) return sessionEvent.data;
  }

  throw new Error("Timed out waiting for session SSE event.");
}

function parseSseBlocks(buffer) {
  const events = [];
  let remainder = buffer;
  let boundary = remainder.indexOf("\n\n");
  while (boundary !== -1) {
    const block = remainder.slice(0, boundary);
    remainder = remainder.slice(boundary + 2);
    boundary = remainder.indexOf("\n\n");

    const eventName = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7) || "message";
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    if (data) events.push({ event: eventName, data: JSON.parse(data) });
  }
  return { events, remainder };
}

async function freePort() {
  const server = http.createServer((req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
