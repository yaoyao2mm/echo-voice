import os from "node:os";
import fs from "node:fs";
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
    timeoutMs: config.codex.timeoutMs,
    worktreeMode: config.codex.worktreeMode
  };
}

export function buildCodexEnv() {
  const userInfo = os.userInfo();
  const home = process.env.HOME || os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const codexAuthApiKey = process.env.OPENAI_API_KEY ? "" : readCodexAuthApiKey(codexHome);
  return buildProxyEnv({
    ...process.env,
    PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    USER: process.env.USER || userInfo.username,
    LOGNAME: process.env.LOGNAME || userInfo.username,
    SHELL: process.env.SHELL || "/bin/zsh",
    CODEX_HOME: codexHome,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || codexAuthApiKey || "",
    LANG: process.env.LANG || "en_US.UTF-8"
  });
}

function readCodexAuthApiKey(codexHome) {
  try {
    const authPath = path.join(codexHome, "auth.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    return String(auth.OPENAI_API_KEY || "").trim();
  } catch {
    return "";
  }
}
