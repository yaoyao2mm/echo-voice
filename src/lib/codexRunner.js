import { spawn } from "node:child_process";
import { config } from "../config.js";

export function publicWorkspaces() {
  return config.codex.workspaces.map((workspace) => ({
    id: workspace.id,
    label: workspace.label,
    path: workspace.path
  }));
}

export async function runCodexJob(job, hooks = {}) {
  const workspace = config.codex.workspaces.find((item) => item.id === job.projectId);
  if (!workspace) {
    throw new Error(`Project is not allowed on this desktop agent: ${job.projectId}`);
  }

  const args = ["exec", "--json", "--full-auto", "--skip-git-repo-check", "-C", workspace.path];
  if (config.codex.sandbox) args.push("--sandbox", config.codex.sandbox);
  if (config.codex.model) args.push("--model", config.codex.model);
  if (config.codex.profile) args.push("--profile", config.codex.profile);
  args.push("-");

  await hooks.onEvents?.([
    {
      type: "runner",
      text: `Starting Codex in ${workspace.path}`
    }
  ]);

  return new Promise((resolve) => {
    const child = spawn(config.codex.command, args, {
      cwd: workspace.path,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let finalMessage = "";
    let settled = false;

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        exitCode: null,
        error: `Codex task timed out after ${Math.round(config.codex.timeoutMs / 1000)}s`,
        finalMessage
      });
    }, config.codex.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseJsonLine(line);
        if (event?.text) finalMessage = event.text;
        hooks.onEvents?.([event]);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuffer += text;
      hooks.onEvents?.([{ type: "stderr", text }]);
    });

    child.on("error", (error) => {
      finish({
        ok: false,
        exitCode: null,
        error: error.message,
        finalMessage
      });
    });

    child.on("close", (code) => {
      finish({
        ok: code === 0,
        exitCode: code,
        error: code === 0 ? "" : stderrBuffer.slice(-4000) || `Codex exited with ${code}`,
        finalMessage
      });
    });

    child.stdin.write(job.prompt);
    child.stdin.end();

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }
  });
}

function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return { type: "output", text: "" };

  try {
    const raw = JSON.parse(trimmed);
    return {
      type: raw.type || raw.event || "json",
      text: extractText(raw),
      raw
    };
  } catch {
    return { type: "output", text: trimmed };
  }
}

function extractText(raw) {
  if (typeof raw.message === "string") return raw.message;
  if (typeof raw.text === "string") return raw.text;
  if (typeof raw.content === "string") return raw.content;
  if (typeof raw.item?.text === "string") return raw.item.text;
  if (typeof raw.item?.content === "string") return raw.item.content;
  if (typeof raw.delta === "string") return raw.delta;
  if (raw.type) return `[${raw.type}]`;
  return JSON.stringify(raw).slice(0, 2000);
}
