import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { publicWorkspaces } from "./codexRunner.js";

const execFileAsync = promisify(execFile);
const gitTimeoutMs = 15000;

export async function prepareCodexSessionWorktree(command) {
  if (command.execution?.path) return command;
  if (command.type !== "start") return command;
  if (config.codex.worktreeMode !== "always") return command;

  const baseWorkspace = publicWorkspaces().find((workspace) => workspace.id === command.projectId);
  if (!baseWorkspace) throw new Error(`Project is not allowed on this desktop agent: ${command.projectId}`);

  const basePath = baseWorkspace.path;
  const root = (await git(basePath, ["rev-parse", "--show-toplevel"])).trim();
  const baseCommit = (await git(root, ["rev-parse", "HEAD"])).trim();
  const baseBranch = (await git(root, ["branch", "--show-current"]).catch(() => "")).trim();
  const branchName = `echo/job-${shortId(command.sessionId)}`;
  const worktreePath = path.join(config.codex.worktreeRoot, sanitizePathSegment(baseWorkspace.id), command.sessionId);
  const existing = await existingWorktreeExecution(worktreePath, {
    baseWorkspace,
    root,
    branchName,
    baseBranch,
    baseCommit
  });
  if (existing) {
    return {
      ...command,
      execution: existing
    };
  }

  const status = await git(root, ["status", "--porcelain"]);
  if (status.trim()) {
    throw new Error(
      `Cannot create an isolated Codex worktree for ${baseWorkspace.label || baseWorkspace.id} because the base workspace has uncommitted changes.`
    );
  }

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  if (await branchExists(root, branchName)) {
    await git(root, ["worktree", "add", worktreePath, branchName]);
  } else {
    await git(root, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);
  }
  const createdWorktreeRoot = (await git(worktreePath, ["rev-parse", "--show-toplevel"])).trim();

  return {
    ...command,
    execution: {
      mode: "worktree",
      baseWorkspaceId: baseWorkspace.id,
      basePath: root,
      path: createdWorktreeRoot || worktreePath,
      branchName,
      baseBranch,
      baseCommit,
      createdAt: new Date().toISOString()
    }
  };
}

async function existingWorktreeExecution(worktreePath, metadata) {
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) {
      throw new Error(`Codex worktree path already exists and is not a directory: ${worktreePath}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  let worktreeRoot = "";
  try {
    worktreeRoot = (await git(worktreePath, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new Error(`Codex worktree path already exists but is not a Git worktree: ${worktreePath}`);
  }

  return {
    mode: "worktree",
    baseWorkspaceId: metadata.baseWorkspace.id,
    basePath: metadata.root,
    path: worktreeRoot || worktreePath,
    branchName: metadata.branchName,
    baseBranch: metadata.baseBranch,
    baseCommit: metadata.baseCommit,
    createdAt: new Date().toISOString(),
    reused: true
  };
}

async function branchExists(cwd, branchName) {
  try {
    await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd, args) {
  const result = await execFileAsync("git", args, {
    cwd,
    timeout: gitTimeoutMs,
    maxBuffer: 1024 * 1024
  });
  return result.stdout;
}

function shortId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .slice(0, 12) || Date.now().toString(36);
}

function sanitizePathSegment(value) {
  return String(value || "workspace")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "workspace";
}
