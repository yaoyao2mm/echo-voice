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
