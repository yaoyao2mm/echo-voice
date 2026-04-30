import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultGitTimeoutMs = 10000;

export async function summarizeGitWorkspace(workspacePath, options = {}) {
  const cwd = String(workspacePath || "").trim();
  if (!cwd) return null;

  const timeout = Number(options.timeoutMs || defaultGitTimeoutMs);
  const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"], timeout).catch(() => null);
  const root = rootResult?.stdout.trim();
  if (!root) return null;

  const [branchResult, commitResult, statusResult, diffStatResult] = await Promise.all([
    runGit(root, ["branch", "--show-current"], timeout).catch(() => ({ stdout: "" })),
    runGit(root, ["rev-parse", "--short", "HEAD"], timeout).catch(() => ({ stdout: "" })),
    runGit(root, ["status", "--short"], timeout).catch(() => ({ stdout: "" })),
    runGit(root, ["diff", "--stat", "--"], timeout).catch(() => ({ stdout: "" }))
  ]);

  const statusShort = statusResult.stdout.trim();
  const diffStat = diffStatResult.stdout.trim();
  const changedFiles = parseChangedFiles(statusResult.stdout);
  if (!statusShort && !diffStat) {
    return {
      root,
      branch: branchResult.stdout.trim(),
      commit: commitResult.stdout.trim(),
      statusShort: "",
      diffStat: "",
      changedFiles: []
    };
  }

  return {
    root,
    branch: branchResult.stdout.trim(),
    commit: commitResult.stdout.trim(),
    statusShort,
    diffStat,
    changedFiles
  };
}

export function formatGitSummary(summary) {
  if (!summary) return "";
  const lines = [];
  const head = [summary.branch, summary.commit].filter(Boolean).join(" @ ");
  if (head) lines.push(`Git: ${head}`);
  if (summary.changedFiles?.length) {
    lines.push(`Changed files: ${summary.changedFiles.length}`);
    lines.push(...summary.changedFiles.slice(0, 40).map((file) => `- ${file}`));
  } else {
    lines.push("No Git changes detected.");
  }
  if (summary.diffStat) {
    lines.push("", summary.diffStat);
  }
  return lines.join("\n");
}

function parseChangedFiles(statusShort) {
  const files = [];
  for (const line of String(statusShort || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const pathPart = line.slice(3).trim();
    if (!pathPart) continue;
    const renamed = pathPart.split(" -> ").pop();
    files.push(renamed || pathPart);
  }
  return Array.from(new Set(files));
}

async function runGit(cwd, args, timeoutMs) {
  return execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });
}
