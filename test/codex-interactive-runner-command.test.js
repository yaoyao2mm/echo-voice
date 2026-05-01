import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("CodexInteractiveRuntime uses the resolved desktop command on macOS", () => {
  if (process.platform !== "darwin") return;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-command-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeShellDir = path.join(tempRoot, "bin");
  const fakeAppPath = path.join(tempRoot, "fake-codex-app");
  const fakeShellPath = path.join(fakeShellDir, "codex");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(fakeShellDir, { recursive: true });

  fs.writeFileSync(
    fakeAppPath,
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
    send({ id: message.id, result: { thread: { id: "thr_fake", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1 } } });
    return;
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeAppPath, 0o755);

  fs.writeFileSync(fakeShellPath, "#!/usr/bin/env bash\necho shell-codex-invoked >&2\nexit 97\n", "utf8");
  fs.chmodSync(fakeShellPath, 0o755);

  const script = `
import assert from "node:assert/strict";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = "codex";
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeAppPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const runtime = new CodexInteractiveRuntime();
try {
  const result = await runtime.handleCommand({
    sessionId: "session-1",
    type: "start",
    projectId: "demo",
    payload: { prompt: "", attachments: [] },
    runtime: {}
  });
  assert.equal(result.ok, true);
  assert.equal(runtime.client.command, ${JSON.stringify(fakeAppPath)});
} finally {
  runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script,
    env: {
      ...process.env,
      PATH: `${fakeShellDir}:${process.env.PATH || ""}`
    }
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("CodexInteractiveRuntime accepts managed workspaces created by the desktop agent", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-managed-workspace-"));
  const homePath = path.join(tempRoot, "home");
  const workspaceRoot = path.join(tempRoot, "projects");
  const configuredWorkspacePath = path.join(tempRoot, "configured");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(configuredWorkspacePath, { recursive: true });

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
    send({ id: message.id, result: { thread: { id: "thr_managed", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import path from "node:path";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`configured=${configuredWorkspacePath}`)};
process.env.ECHO_CODEX_WORKSPACE_ROOT = ${JSON.stringify(workspaceRoot)};

const manager = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexWorkspaceManager.js"))});
const runner = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexRunner.js"))});
const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const workspace = manager.createManagedWorkspace({ name: "managed project" });
assert.equal(path.dirname(workspace.path), ${JSON.stringify(workspaceRoot)});
assert.equal(runner.publicWorkspaces().some((item) => item.id === workspace.id), true);

const runtime = new CodexInteractiveRuntime();
try {
  const result = await runtime.handleCommand({
    sessionId: "session-managed",
    type: "start",
    projectId: workspace.id,
    payload: { prompt: "", attachments: [] },
    runtime: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.appThreadId, "thr_managed");
} finally {
  runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("CodexInteractiveRuntime coalesces streaming assistant deltas", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-delta-buffer-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
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
    send({ id: message.id, result: { thread: { id: "thr_stream", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    const turn = { id: "turn_stream", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
    for (const delta of ["Hello", " ", "from", " ", "Echo"]) {
      send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: turn.id, itemId: "msg_1", delta } });
    }
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: turn.id, item: { type: "agentMessage", id: "msg_1", text: "Hello from Echo" } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { ...turn, status: "completed", completedAt: 2 } } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const batches = [];
let resolveCompleted;
const completed = new Promise((resolve) => {
  resolveCompleted = resolve;
});
const runtime = new CodexInteractiveRuntime({
  onEvents: async (_id, events) => {
    batches.push(events);
    if (events.some((event) => event.type === "turn/completed")) resolveCompleted();
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-stream",
    type: "start",
    projectId: "demo",
    payload: { prompt: "stream", attachments: [] },
    runtime: {}
  });
  assert.equal(result.ok, true);
  await Promise.race([
    completed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for completion")), 2000))
  ]);

  const events = batches.flat();
  const deltaEvents = events.filter((event) => event.type === "item/agentMessage/delta");
  assert.equal(deltaEvents.length, 1);
  assert.equal(deltaEvents[0].text, "Hello from Echo");
  assert.equal(deltaEvents[0].raw.params.delta, "Hello from Echo");
  assert.equal(events.findIndex((event) => event.type === "item/agentMessage/delta") < events.findIndex((event) => event.type === "item/completed"), true);
} finally {
  runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("CodexInteractiveRuntime keeps restored token usage notifications mapped to the session", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-token-usage-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const tokenUsage = {
  total: { totalTokens: 64000, inputTokens: 60000, cachedInputTokens: 1000, outputTokens: 4000, reasoningOutputTokens: 500 },
  last: { totalTokens: 42000, inputTokens: 40000, cachedInputTokens: 800, outputTokens: 2000, reasoningOutputTokens: 300 },
  modelContextWindow: 128000
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") {
    send({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId: "turn_restored", tokenUsage } });
    send({ id: message.id, result: { thread: { id: message.params.threadId, preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_after_resume", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const events = [];
let resolveUsage;
const usageSeen = new Promise((resolve) => {
  resolveUsage = resolve;
});
const runtime = new CodexInteractiveRuntime({
  onEvents: async (_id, batch) => {
    events.push(...batch);
    if (batch.some((event) => event.type === "thread/tokenUsage/updated")) resolveUsage();
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-resume",
    type: "message",
    projectId: "demo",
    appThreadId: "thr_resume",
    payload: { text: "continue", attachments: [], history: [] },
    runtime: {}
  });
  assert.equal(result.ok, true);
  await Promise.race([
    usageSeen,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for token usage")), 2000))
  ]);

  const event = events.find((item) => item.type === "thread/tokenUsage/updated");
  assert.equal(event.appThreadId, "thr_resume");
  assert.equal(event.raw.params.tokenUsage.last.totalTokens, 42000);
} finally {
  runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("CodexInteractiveRuntime restarts app-server once after stale Codex auth", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-auth-retry-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const attemptsPath = path.join(tempRoot, "attempts.txt");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(attemptsPath, "0", "utf8");
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const attemptsPath = ${JSON.stringify(attemptsPath)};
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
    const attempts = Number(fs.readFileSync(attemptsPath, "utf8")) + 1;
    fs.writeFileSync(attemptsPath, String(attempts), "utf8");
    if (attempts === 1) {
      send({ id: message.id, error: { code: -32603, message: "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again." } });
      return;
    }
    send({ id: message.id, result: { thread: { id: "thr_after_auth_retry", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const runtime = new CodexInteractiveRuntime();
try {
  const result = await runtime.handleCommand({
    sessionId: "session-auth-retry",
    type: "start",
    projectId: "demo",
    payload: { prompt: "", attachments: [] },
    runtime: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.appThreadId, "thr_after_auth_retry");
  assert.equal(fs.readFileSync(${JSON.stringify(attemptsPath)}, "utf8"), "2");
} finally {
  runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});
