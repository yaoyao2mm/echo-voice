import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultGitTimeoutMs = 10000;

export async function summarizeGitWorkspace(workspacePath, options = {}) {
  const after = await gitWorkspaceSnapshot(workspacePath, options);
  if (!after) return null;

  const baseline = options.baseline && typeof options.baseline === "object" ? options.baseline : null;
  const delta = baseline ? await gitWorkspaceDelta(after.root, baseline, after, options) : null;

  return {
    ...after,
    baseline: baseline ? compactSnapshot(baseline) : null,
    changedDuringTurn: delta,
    changedFileCount: after.changedFiles.length
  };
}

export async function gitWorkspaceSnapshot(workspacePath, options = {}) {
  const cwd = String(workspacePath || "").trim();
  if (!cwd) return null;

  const timeout = Number(options.timeoutMs || defaultGitTimeoutMs);
  const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"], timeout).catch(() => null);
  const root = rootResult?.stdout.trim();
  if (!root) return null;

  const [branchResult, commitResult, fullCommitResult, statusResult, diffStatResult] = await Promise.all([
    runGit(root, ["branch", "--show-current"], timeout).catch(() => ({ stdout: "" })),
    runGit(root, ["rev-parse", "--short", "HEAD"], timeout).catch(() => ({ stdout: "" })),
    runGit(root, ["rev-parse", "HEAD"], timeout).catch(() => ({ stdout: "" })),
    runGit(root, ["status", "--short"], timeout).catch(() => ({ stdout: "" })),
    runGit(root, ["diff", "--stat", "--"], timeout).catch(() => ({ stdout: "" }))
  ]);

  const statusShort = statusResult.stdout.trim();
  const statusEntries = parseStatusEntries(statusResult.stdout);
  return {
    root,
    branch: branchResult.stdout.trim(),
    commit: commitResult.stdout.trim(),
    commitFull: fullCommitResult.stdout.trim(),
    statusShort,
    diffStat: diffStatResult.stdout.trim(),
    changedFiles: statusEntries.map((entry) => entry.path),
    statusEntries
  };
}

export function formatGitSummary(summary) {
  if (!summary) return "";
  const lines = [];
  const head = [summary.branch, summary.commit].filter(Boolean).join(" @ ");
  if (head) lines.push(`Git: ${head}`);
  if (summary.changedDuringTurn) {
    const delta = summary.changedDuringTurn;
    if (delta.changedFiles?.length) {
      lines.push(`Changed this turn: ${delta.changedFiles.length}`);
      lines.push(...delta.changedFiles.slice(0, 40).map((file) => `- ${file}`));
    } else {
      lines.push("Changed this turn: none detected.");
    }
    if (delta.commitChanged && delta.commitBefore && delta.commitAfter) {
      lines.push(`HEAD: ${delta.commitBefore} -> ${delta.commitAfter}`);
    }
  }
  if (summary.changedFiles?.length) {
    lines.push(summary.changedDuringTurn ? `Workspace changes now: ${summary.changedFiles.length}` : `Changed files: ${summary.changedFiles.length}`);
    lines.push(...summary.changedFiles.slice(0, 40).map((file) => `- ${file}`));
  } else {
    lines.push("No Git changes detected.");
  }
  if (summary.changedDuringTurn?.diffStat) {
    lines.push("", summary.changedDuringTurn.diffStat);
  } else if (summary.diffStat) {
    lines.push("", summary.diffStat);
  }
  return lines.join("\n");
}

async function gitWorkspaceDelta(root, before, after, options = {}) {
  const timeout = Number(options.timeoutMs || defaultGitTimeoutMs);
  const beforeEntries = new Map((before.statusEntries || []).map((entry) => [entry.path, entry.status]));
  const afterEntries = new Map((after.statusEntries || []).map((entry) => [entry.path, entry.status]));
  const changed = new Set();

  for (const [file, status] of afterEntries) {
    if (beforeEntries.get(file) !== status) changed.add(file);
  }
  for (const file of beforeEntries.keys()) {
    if (!afterEntries.has(file)) changed.add(file);
  }

  const commitChanged = Boolean(before.commitFull && after.commitFull && before.commitFull !== after.commitFull);
  let commitDiffStat = "";
  if (commitChanged) {
    const range = `${before.commitFull}..${after.commitFull}`;
    const [nameResult, statResult] = await Promise.all([
      runGit(root, ["diff", "--name-only", range], timeout).catch(() => ({ stdout: "" })),
      runGit(root, ["diff", "--stat", range], timeout).catch(() => ({ stdout: "" }))
    ]);
    for (const file of nameResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      changed.add(file);
    }
    commitDiffStat = statResult.stdout.trim();
  }

  return {
    changedFiles: Array.from(changed).sort(),
    diffStat: commitDiffStat || after.diffStat || "",
    commitChanged,
    commitBefore: before.commit || shortCommit(before.commitFull),
    commitAfter: after.commit || shortCommit(after.commitFull),
    statusBefore: before.statusShort || "",
    statusAfter: after.statusShort || ""
  };
}

function parseStatusEntries(statusShort) {
  const entries = [];
  for (const line of String(statusShort || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const pathPart = line.slice(3).trim();
    if (!pathPart) continue;
    const renamed = pathPart.split(" -> ").pop();
    entries.push({
      status: line.slice(0, 2).trim() || "??",
      path: renamed || pathPart
    });
  }
  const byPath = new Map();
  for (const entry of entries) byPath.set(entry.path, entry);
  return Array.from(byPath.values());
}

function compactSnapshot(snapshot = {}) {
  return {
    root: snapshot.root || "",
    branch: snapshot.branch || "",
    commit: snapshot.commit || shortCommit(snapshot.commitFull),
    commitFull: snapshot.commitFull || "",
    statusShort: snapshot.statusShort || "",
    changedFiles: Array.isArray(snapshot.changedFiles) ? snapshot.changedFiles.slice(0, 80) : []
  };
}

function shortCommit(value) {
  const text = String(value || "").trim();
  return text.length > 12 ? text.slice(0, 7) : text;
}

async function runGit(cwd, args, timeoutMs) {
  return execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });
}
