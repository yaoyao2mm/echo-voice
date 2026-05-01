import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { publicWorkspaces } from "./codexRunner.js";

const execFileAsync = promisify(execFile);
const gitTimeoutMs = 15000;
const cleanupIntervalMs = 6 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
let nextCleanupAt = 0;

export async function prepareCodexSessionWorktree(command) {
  if (command.execution?.path) {
    await touchCodexSessionWorktree(command);
    return command;
  }
  if (command.type !== "start") return command;
  if (!shouldUseWorktree(command)) return command;

  const baseWorkspace = publicWorkspaces().find((workspace) => workspace.id === command.projectId);
  if (!baseWorkspace) throw new Error(`Project is not allowed on this desktop agent: ${command.projectId}`);

  const basePath = baseWorkspace.path;
  const root = (await git(basePath, ["rev-parse", "--show-toplevel"])).trim();
  const baseCommit = (await git(root, ["rev-parse", "HEAD"])).trim();
  const baseBranch = (await git(root, ["branch", "--show-current"]).catch(() => "")).trim();
  const branchName = `echo/job-${shortId(command.sessionId)}`;
  const worktreePath = path.join(config.codex.worktreeRoot, sanitizePathSegment(baseWorkspace.id), command.sessionId);
  const existing = await existingWorktreeExecution(worktreePath, {
    sessionId: command.sessionId,
    baseWorkspace,
    root,
    branchName,
    baseBranch,
    baseCommit
  });
  if (existing) {
    await writeWorktreeMetadata(existing);
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

  const prepared = {
    ...command,
    execution: {
      mode: "worktree",
      sessionId: command.sessionId,
      baseWorkspaceId: baseWorkspace.id,
      basePath: root,
      path: createdWorktreeRoot || worktreePath,
      branchName,
      baseBranch,
      baseCommit,
      createdAt: new Date().toISOString()
    }
  };
  await writeWorktreeMetadata(prepared.execution);
  return prepared;
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
    sessionId: metadata.sessionId,
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

export async function maybeCleanupCodexSessionWorktrees(options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  if (!options.force && nowMs < nextCleanupAt) return null;
  nextCleanupAt = nowMs + cleanupIntervalMs;
  return cleanupCodexSessionWorktrees({ ...options, nowMs });
}

export async function cleanupCodexSessionWorktrees(options = {}) {
  const retentionDays = Number(options.retentionDays ?? config.codex.worktreeRetentionDays ?? 14);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { checked: 0, removed: 0, skippedDirty: 0, skippedYoung: 0, skippedInvalid: 0 };
  }

  const root = path.resolve(config.codex.worktreeRoot);
  const nowMs = Number(options.nowMs || Date.now());
  const cutoffMs = nowMs - retentionDays * dayMs;
  const result = { checked: 0, removed: 0, skippedDirty: 0, skippedYoung: 0, skippedInvalid: 0 };

  let projects = [];
  try {
    projects = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }

  for (const projectEntry of projects) {
    if (!projectEntry.isDirectory() || projectEntry.name.startsWith(".")) continue;
    const projectPath = path.join(root, projectEntry.name);
    let sessions = [];
    try {
      sessions = await fs.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessionEntry of sessions) {
      if (!sessionEntry.isDirectory() || sessionEntry.name.startsWith(".")) continue;
      const worktreePath = path.join(projectPath, sessionEntry.name);
      const resolvedPath = path.resolve(worktreePath);
      if (!isPathInside(resolvedPath, root)) {
        result.skippedInvalid += 1;
        continue;
      }

      result.checked += 1;
      const metadata = await readWorktreeMetadata(projectEntry.name, sessionEntry.name);
      const touchedAtMs = metadata?.touchedAt ? Date.parse(metadata.touchedAt) : NaN;
      const fallbackStat = await fs.stat(resolvedPath).catch(() => null);
      const lastSeenMs = Number.isFinite(touchedAtMs) ? touchedAtMs : fallbackStat?.mtimeMs || nowMs;
      if (lastSeenMs > cutoffMs) {
        result.skippedYoung += 1;
        continue;
      }

      const status = await git(resolvedPath, ["status", "--porcelain"]).catch(() => null);
      if (status === null) {
        result.skippedInvalid += 1;
        continue;
      }
      if (status.trim()) {
        result.skippedDirty += 1;
        continue;
      }

      const removeCwd = metadata?.basePath && (await pathExists(metadata.basePath)) ? metadata.basePath : resolvedPath;
      await git(removeCwd, ["worktree", "remove", "--force", resolvedPath]).catch(async () => {
        await fs.rm(resolvedPath, { recursive: true, force: true });
        await git(removeCwd, ["worktree", "prune"]).catch(() => "");
      });
      await removeWorktreeMetadata(projectEntry.name, sessionEntry.name);
      result.removed += 1;
    }
  }

  return result;
}

export async function touchCodexSessionWorktree(commandOrExecution) {
  const execution = commandOrExecution?.execution || commandOrExecution;
  if (execution?.mode !== "worktree" || !execution.path) return false;
  await writeWorktreeMetadata(execution);
  return true;
}

function shouldUseWorktree(command) {
  if (config.codex.worktreeMode === "always") return true;
  return config.codex.worktreeMode === "optional" && String(command.runtime?.worktreeMode || "").trim() === "always";
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

async function writeWorktreeMetadata(execution = {}) {
  const worktreePath = String(execution.path || "").trim();
  if (!worktreePath) return;
  const resolvedPath = path.resolve(worktreePath);
  const root = path.resolve(config.codex.worktreeRoot);
  if (!isPathInside(resolvedPath, root)) return;

  const sessionId = String(execution.sessionId || path.basename(resolvedPath) || "").trim();
  const projectId = sanitizePathSegment(execution.baseWorkspaceId || path.basename(path.dirname(resolvedPath)));
  if (!sessionId || !projectId) return;

  const metadataPath = worktreeMetadataPath(projectId, sessionId);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    metadataPath,
    JSON.stringify(
      {
        mode: "worktree",
        sessionId,
        baseWorkspaceId: execution.baseWorkspaceId || "",
        path: resolvedPath,
        branchName: execution.branchName || "",
        basePath: execution.basePath || "",
        baseBranch: execution.baseBranch || "",
        baseCommit: execution.baseCommit || "",
        createdAt: execution.createdAt || now,
        touchedAt: now
      },
      null,
      2
    ),
    "utf8"
  );
}

async function readWorktreeMetadata(projectId, sessionId) {
  try {
    const text = await fs.readFile(worktreeMetadataPath(projectId, sessionId), "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function removeWorktreeMetadata(projectId, sessionId) {
  await fs.rm(worktreeMetadataPath(projectId, sessionId), { force: true }).catch(() => {});
}

function worktreeMetadataPath(projectId, sessionId) {
  return path.join(config.codex.worktreeRoot, ".metadata", sanitizePathSegment(projectId), `${sanitizePathSegment(sessionId)}.json`);
}

async function pathExists(candidatePath) {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
