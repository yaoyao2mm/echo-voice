import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { resolveDesktopCodexCommand } from "./codexCommand.js";
import { codexCompatibleModel, listUnsupportedCodexModels, normalizeAllowedPermissionModes } from "./codexRuntime.js";
import { managedWorkspaces } from "./codexWorkspaceManager.js";
import { buildProxyEnv } from "./http.js";

export function publicWorkspaces() {
  const byKey = new Map();
  for (const workspace of [...config.codex.workspaces, ...managedWorkspaces()]) {
    const id = String(workspace.id || "").trim();
    const workspacePath = String(workspace.path || "").trim();
    if (!id || !workspacePath) continue;
    const key = `${id}:${workspacePath}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      id,
      label: String(workspace.label || id).trim(),
      path: workspacePath
    });
  }
  return Array.from(byKey.values());
}

export function publicCodexRuntime() {
  const commandInfo = resolveDesktopCodexCommand({
    configuredCommand: config.codex.command,
    bundledPath: config.codex.appPath
  });
  return {
    command: commandInfo.command,
    commandSource: commandInfo.source,
    commandDetail: commandInfo.detail,
    sandbox: config.codex.sandbox || "workspace-write",
    approvalPolicy: config.codex.approvalPolicy,
    approvalTimeoutMs: config.codex.approvalTimeoutMs,
    model: codexCompatibleModel(config.codex.model),
    unsupportedModels: listUnsupportedCodexModels(),
    supportedModels: [],
    allowedPermissionModes: normalizeAllowedPermissionModes(),
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
