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
process.env.ECHO_CODEX_WORKTREE_MODE = "always";
process.env.ECHO_CODEX_WORKTREE_ROOT = worktreeRoot;

const { formatGitSummary, summarizeGitWorkspace } = await import("../src/lib/codexGitSummary.js");
const { prepareCodexSessionWorktree } = await import("../src/lib/codexWorktree.js");

test("prepareCodexSessionWorktree creates and reuses an isolated Git worktree for a clean workspace", async () => {
  initRepo(workspacePath);

  const command = {
    id: "cmd-1",
    sessionId: "session-worktree-123456",
    type: "start",
    projectId: "demo",
    runtime: {},
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
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# demo\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Echo Test", "-c", "user.email=echo@example.test", "commit", "-m", "init"], {
    cwd: repoPath,
    stdio: "ignore"
  });
}
