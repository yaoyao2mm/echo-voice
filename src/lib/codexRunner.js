import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { buildProxyEnv } from "./http.js";

export function publicWorkspaces() {
  return config.codex.workspaces.map((workspace) => ({
    id: workspace.id,
    label: workspace.label,
    path: workspace.path
  }));
}

export function publicCodexRuntime() {
  return {
    command: config.codex.command,
    sandbox: config.codex.sandbox || "workspace-write",
    model: config.codex.model,
    profile: config.codex.profile,
    timeoutMs: config.codex.timeoutMs
  };
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
      text: `Starting Codex in ${workspace.path}${config.codex.model ? ` with ${config.codex.model}` : " with Codex default model"}`
    }
  ]);

  return new Promise((resolve) => {
    const child = spawn(config.codex.command, args, {
      cwd: workspace.path,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildCodexEnv()
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let finalMessage = "";
    let explicitError = "";
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
        if (shouldUseAsFinalMessage(event)) finalMessage = event.text;
        if (event?.type === "error" || event?.type === "turn.failed") {
          explicitError = event.text || explicitError;
        }
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
        error: code === 0 ? "" : humanizeCodexError(explicitError || stderrBuffer, code),
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

function buildCodexEnv() {
  const userInfo = os.userInfo();
  const home = process.env.HOME || os.homedir();
  return buildProxyEnv({
    ...process.env,
    PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    USER: process.env.USER || userInfo.username,
    LOGNAME: process.env.LOGNAME || userInfo.username,
    SHELL: process.env.SHELL || "/bin/zsh",
    CODEX_HOME: process.env.CODEX_HOME || path.join(home, ".codex"),
    LANG: process.env.LANG || "en_US.UTF-8"
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

function shouldUseAsFinalMessage(event) {
  if (!event?.text) return false;
  if (event.raw?.type === "item.completed" && event.raw?.item?.type === "agent_message") return true;
  if (["turn.completed", "turn.started", "thread.started"].includes(event.type)) return false;
  return !/^\[[a-z_.-]+\]$/i.test(event.text);
}

function extractText(raw) {
  if (typeof raw.message === "string") return raw.message;
  if (typeof raw.text === "string") return raw.text;
  if (typeof raw.content === "string") return raw.content;
  if (typeof raw.item?.text === "string") return raw.item.text;
  if (typeof raw.item?.content === "string") return raw.item.content;
  if (typeof raw.error?.message === "string") return raw.error.message;
  if (typeof raw.delta === "string") return raw.delta;
  if (raw.type) return `[${raw.type}]`;
  return JSON.stringify(raw).slice(0, 2000);
}

function humanizeCodexError(input, code) {
  const raw = String(input || "").trim();
  const message = extractCodexErrorMessage(raw) || raw.slice(-4000) || `Codex exited with ${code}`;

  if (/requires a newer version of Codex|Please upgrade to the latest app or CLI/i.test(message)) {
    return `${message}\n\n建议：升级 Codex CLI，或在桌面端 Codex 设置里指定当前 CLI 支持的模型，例如 gpt-5.4。`;
  }

  if (/ENOENT|No such file or directory/i.test(message)) {
    return `${message}\n\n建议：检查 ECHO_CODEX_COMMAND 是否在桌面 agent 的 PATH 中，或填入 codex 的绝对路径。`;
  }

  return message;
}

function extractCodexErrorMessage(raw) {
  const candidates = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const line of candidates) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.message === "string") return extractNestedErrorMessage(parsed.message);
      if (typeof parsed.error?.message === "string") return parsed.error.message;
    } catch {
      // Keep looking for a structured Codex error.
    }
  }

  return extractNestedErrorMessage(raw);
}

function extractNestedErrorMessage(value) {
  const text = String(value || "").trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // The original string is already the best message.
  }
  return text;
}
