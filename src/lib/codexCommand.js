import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const defaultMacosBundledCodexPath = "/Applications/Codex.app/Contents/Resources/codex";

export function bundledCodexCommandPath(platform = process.platform, existsSync = fs.existsSync, options = {}) {
  if (platform !== "darwin") return "";
  const candidates = bundledCodexCommandCandidates(options);
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

export function resolveCodexCommand(command, options = {}) {
  const raw = String(command || "").trim() || "codex";
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;
  if (raw !== "codex") return raw;
  return bundledCodexCommandPath(platform, existsSync, options) || raw;
}

export function resolveDesktopCodexCommand(options = {}) {
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;
  const configuredCommand = String(options.configuredCommand || "").trim();
  const bundledCommand = bundledCodexCommandPath(platform, existsSync, options);

  if (platform === "darwin") {
    if (!bundledCommand) {
      return {
        ok: false,
        command: "",
        source: "missing-codex-app",
        detail:
          "Codex.app is required on macOS. Install the official Codex app, or set ECHO_CODEX_APP_PATH to its bundled codex binary."
      };
    }

    const ignoresLegacyCommand = configuredCommand && configuredCommand !== "codex" && configuredCommand !== bundledCommand;
    return {
      ok: true,
      command: bundledCommand,
      source: "codex-app",
      detail: ignoresLegacyCommand
        ? `Using Codex.app at ${bundledCommand}. Ignoring legacy ECHO_CODEX_COMMAND=${configuredCommand}.`
        : `Using Codex.app at ${bundledCommand}.`
    };
  }

  const command = resolveCodexCommand(configuredCommand || "codex", options);
  return {
    ok: Boolean(command),
    command,
    source: configuredCommand && configuredCommand !== "codex" ? "custom-command" : "shell-command",
    detail: command ? `Using ${command}.` : "Codex command is not configured."
  };
}

function bundledCodexCommandCandidates(options = {}) {
  const explicitPath = String(options.bundledPath || process.env.ECHO_CODEX_APP_PATH || "").trim();
  const candidates = [
    explicitPath,
    defaultMacosBundledCodexPath,
    path.join(os.homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex")
  ].filter(Boolean);
  return Array.from(new Set(candidates));
}
