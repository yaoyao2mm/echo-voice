import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const macPasteHelperSource = path.resolve(moduleDir, "../../scripts/macos-paste-helper.swift");
const macPasteHelperBinary = path.join(config.dataDir, "macos-paste-helper");

export async function insertText(text) {
  const value = String(text || "");
  if (!value.trim()) {
    const error = new Error("Cannot insert empty text.");
    error.statusCode = 400;
    throw error;
  }

  await setClipboard(value);

  if (config.insertMode === "copy") {
    return { mode: "copy", pasted: false, message: "Text copied to clipboard." };
  }

  const platform = os.platform();
  if (platform === "darwin") {
    await pasteMac();
    return { mode: "paste", pasted: true, message: "Text pasted with Cmd+V." };
  }

  if (platform === "win32") {
    await run("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
    ]);
    return { mode: "paste", pasted: true, message: "Text pasted with Ctrl+V." };
  }

  const pasteTool = await firstAvailable(["xdotool", "wtype"]);
  if (pasteTool === "xdotool") {
    await run("xdotool", ["key", "ctrl+v"]);
    return { mode: "paste", pasted: true, message: "Text pasted with xdotool." };
  }
  if (pasteTool === "wtype") {
    await run("wtype", ["-M", "ctrl", "v", "-m", "ctrl"]);
    return { mode: "paste", pasted: true, message: "Text pasted with wtype." };
  }

  return {
    mode: "copy",
    pasted: false,
    message: "Text copied to clipboard. Install xdotool or wtype to auto-paste on Linux."
  };
}

async function pasteMac() {
  const errors = [];

  try {
    await runMacPasteHelper();
    return;
  } catch (error) {
    errors.push(error.message);
  }

  try {
    await run("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
    return;
  } catch (error) {
    errors.push(error.message);
  }

  throw new Error(`macOS auto-paste failed. ${formatMacPasteErrors(errors)}`);
}

async function runMacPasteHelper() {
  await ensureMacPasteHelper();
  await run(macPasteHelperBinary);
}

async function ensureMacPasteHelper() {
  await fs.mkdir(config.dataDir, { recursive: true });

  if (!(await shouldBuildMacPasteHelper())) return;
  const swiftc = await firstAvailable(["swiftc"]);
  if (!swiftc) {
    throw new Error("swiftc is not available to build the macOS paste helper.");
  }
  await run(swiftc, [macPasteHelperSource, "-o", macPasteHelperBinary]);
  await fs.chmod(macPasteHelperBinary, 0o755);
}

async function shouldBuildMacPasteHelper() {
  try {
    const [source, binary] = await Promise.all([
      fs.stat(macPasteHelperSource),
      fs.stat(macPasteHelperBinary)
    ]);
    return source.mtimeMs > binary.mtimeMs;
  } catch {
    return true;
  }
}

function formatMacPasteErrors(errors) {
  const detail = errors.filter(Boolean).join(" | ");
  const permissionHint =
    "Grant Accessibility permission to the Echo paste helper, /opt/homebrew/bin/node, or /usr/bin/osascript, then restart the desktop agent.";
  return [detail, permissionHint].filter(Boolean).join(" ");
}

async function setClipboard(text) {
  const platform = os.platform();

  if (platform === "darwin") {
    await run("pbcopy", [], text);
    return;
  }

  if (platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"], text);
    return;
  }

  const clipboardTool = await firstAvailable(["wl-copy", "xclip", "xsel"]);
  if (clipboardTool === "wl-copy") {
    await run("wl-copy", [], text);
    return;
  }
  if (clipboardTool === "xclip") {
    await run("xclip", ["-selection", "clipboard"], text);
    return;
  }
  if (clipboardTool === "xsel") {
    await run("xsel", ["--clipboard", "--input"], text);
    return;
  }

  throw new Error("No clipboard command found. Install wl-clipboard, xclip, or xsel.");
}

async function firstAvailable(commands) {
  for (const command of commands) {
    if (await commandExists(command)) return command;
  }
  return "";
}

function commandExists(command) {
  const checker = os.platform() === "win32" ? "where" : "which";
  const args = [command];
  return run(checker, args).then(
    () => true,
    () => false
  );
}

function run(command, args = [], input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}
