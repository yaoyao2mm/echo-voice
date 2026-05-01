import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-worktree-test-"));
const tempHome = path.join(tempRoot, "home");
const workspacePath = path.join(tempRoot, "workspace");
const worktreeRoot = path.join(tempRoot, "worktrees");

fs.mkdirSync(tempHome, { recursive: true });
fs.mkdirSync(workspacePath, { recursive: true });
process.env.HOME = tempHome;
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_CODEX_WORKSPACES = `demo=${workspacePath}`;
process.env.ECHO_CODEX_WORKTREE_MODE = "optional";
process.env.ECHO_CODEX_WORKTREE_ROOT = worktreeRoot;

const { formatGitSummary, summarizeGitWorkspace } = await import("../src/lib/codexGitSummary.js");
const { sanitizeRuntimeForAgent } = await import("../src/lib/codexRuntime.js");
const { cleanupCodexSessionWorktrees, prepareCodexSessionWorktree } = await import("../src/lib/codexWorktree.js");

test("prepareCodexSessionWorktree creates and reuses an isolated Git worktree for a clean workspace", async () => {
  initRepo(workspacePath);

  const command = {
    id: "cmd-1",
    sessionId: "session-worktree-123456",
    type: "start",
    projectId: "demo",
    runtime: { worktreeMode: "always" },
    payload: { prompt: "change files" }
  };
  const prepared = await prepareCodexSessionWorktree(command);

  assert.equal(prepared.execution.mode, "worktree");
  assert.equal(prepared.execution.basePath, fs.realpathSync(workspacePath));
  assert.equal(prepared.execution.branchName, "echo/job-sessionworkt");
  assert.equal(prepared.execution.path.startsWith(path.join(fs.realpathSync(worktreeRoot), "demo")), true);
  assert.equal(fs.existsSync(path.join(prepared.execution.path, "README.md")), true);

  fs.appendFileSync(path.join(workspacePath, "README.md"), "dirty base after crash\n", "utf8");
  const retried = await prepareCodexSessionWorktree(command);
  assert.equal(retried.execution.mode, "worktree");
  assert.equal(retried.execution.reused, true);
  assert.equal(retried.execution.path, prepared.execution.path);
  assert.equal(retried.execution.branchName, prepared.execution.branchName);
});

test("sanitizeRuntimeForAgent honors optional desktop worktree policy", () => {
  assert.equal(
    sanitizeRuntimeForAgent({ worktreeMode: "always" }, { worktreeMode: "optional", sandbox: "workspace-write" }).worktreeMode,
    "always"
  );
  assert.equal(sanitizeRuntimeForAgent({}, { worktreeMode: "optional", sandbox: "workspace-write" }).worktreeMode, "always");
  assert.equal(
    sanitizeRuntimeForAgent({ worktreeMode: "off" }, { worktreeMode: "optional", sandbox: "workspace-write" }).worktreeMode,
    "off"
  );
  assert.equal(
    sanitizeRuntimeForAgent({ worktreeMode: "off" }, { worktreeMode: "always", sandbox: "workspace-write" }).worktreeMode,
    "always"
  );
  assert.equal(
    sanitizeRuntimeForAgent({ worktreeMode: "always" }, { worktreeMode: "off", sandbox: "workspace-write" }).worktreeMode,
    "off"
  );
});

test("cleanupCodexSessionWorktrees removes only old clean worktrees", async () => {
  execGit(workspacePath, ["add", "README.md"]);
  execGit(workspacePath, ["-c", "user.name=Echo Test", "-c", "user.email=echo@example.test", "commit", "-m", "checkpoint"]);

  const clean = await prepareCodexSessionWorktree({
    id: "cmd-clean",
    sessionId: "session-clean-worktree",
    type: "start",
    projectId: "demo",
    runtime: { worktreeMode: "always" },
    payload: { prompt: "clean" }
  });
  const dirty = await prepareCodexSessionWorktree({
    id: "cmd-dirty",
    sessionId: "session-dirty-worktree",
    type: "start",
    projectId: "demo",
    runtime: { worktreeMode: "always" },
    payload: { prompt: "dirty" }
  });

  fs.writeFileSync(path.join(dirty.execution.path, "DIRTY.md"), "keep me\n", "utf8");
  const future = Date.now() + 15 * 24 * 60 * 60 * 1000;
  const result = await cleanupCodexSessionWorktrees({ nowMs: future, retentionDays: 14 });

  assert.equal(result.removed >= 1, true);
  assert.equal(result.skippedDirty >= 1, true);
  assert.equal(fs.existsSync(clean.execution.path), false);
  assert.equal(fs.existsSync(dirty.execution.path), true);
});

test("summarizeGitWorkspace reports changed files and diff stats", async () => {
  const repoPath = path.join(tempRoot, "summary-repo");
  initRepo(repoPath);
  fs.appendFileSync(path.join(repoPath, "README.md"), "changed\n", "utf8");

  const summary = await summarizeGitWorkspace(repoPath);
  assert.equal(summary.changedFiles.includes("README.md"), true);
  assert.match(summary.diffStat, /README\.md/);
  assert.match(formatGitSummary(summary), /Changed files: 1/);
});

function initRepo(repoPath) {
  fs.mkdirSync(repoPath, { recursive: true });
  execGit(repoPath, ["init"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# demo\n", "utf8");
  execGit(repoPath, ["add", "README.md"]);
  execGit(repoPath, ["-c", "user.name=Echo Test", "-c", "user.email=echo@example.test", "commit", "-m", "init"]);
}

function execGit(repoPath, args) {
  return execFileSync("git", args, {
    cwd: repoPath,
    stdio: "ignore"
  });
}
