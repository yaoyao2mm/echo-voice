import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { codexCompatibleModel } from "./codexRuntime.js";
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
    approvalPolicy: config.codex.approvalPolicy,
    approvalTimeoutMs: config.codex.approvalTimeoutMs,
    model: codexCompatibleModel(config.codex.model),
    reasoningEffort: config.codex.reasoningEffort,
    profile: config.codex.profile,
    timeoutMs: config.codex.timeoutMs
  };
}

export function buildCodexEnv() {
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
