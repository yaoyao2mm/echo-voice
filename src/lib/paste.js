import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const macPasteHelperSource = path.resolve(moduleDir, "../../scripts/macos-paste-helper.swift");
const macPasteHelperApp = path.join(os.homedir(), "Applications", "Echo Paste Helper.app");
const macPasteHelperBinary = path.join(macPasteHelperApp, "Contents", "MacOS", "Echo Paste Helper");
const macPasteHelperInfoPlist = path.join(macPasteHelperApp, "Contents", "Info.plist");
const macPasteHelperVersion = "3";

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
  try {
    await runMacPasteHelper();
    return;
  } catch (error) {
    throw new Error(`macOS auto-paste failed. ${formatMacPasteErrors([error.message])}`);
  }
}

async function runMacPasteHelper() {
  await ensureMacPasteHelper();
  const status = await runMacPasteHelperApp();
  if (status !== "pasted") {
    throw new Error(`Echo paste helper returned ${status || "no status"}.`);
  }
}

export async function ensureMacPasteHelper({ rebuild = false } = {}) {
  if (!rebuild && (await hasValidMacPasteHelper())) return;

  await fs.mkdir(path.dirname(macPasteHelperBinary), { recursive: true });
  await fs.writeFile(macPasteHelperInfoPlist, macPasteHelperPlist(), "utf8");
  const swiftc = await firstAvailable(["swiftc"]);
  if (!swiftc) {
    throw new Error("swiftc is not available to build the macOS paste helper.");
  }
  await run(swiftc, [macPasteHelperSource, "-o", macPasteHelperBinary]);
  await fs.chmod(macPasteHelperBinary, 0o755);
  await run("codesign", ["--force", "--deep", "--sign", "-", macPasteHelperApp]).catch(() => {});
}

export async function checkMacPasteHelperPermission() {
  await ensureMacPasteHelper();
  const status = await runMacPasteHelperApp(["--check"]);
  if (status !== "trusted") {
    throw new Error(`Echo paste helper returned ${status || "no status"}.`);
  }
}

export async function requestMacPasteHelperPermission() {
  await ensureMacPasteHelper();
  const status = await runMacPasteHelperApp(["--request-permission", "--check"], { timeoutMs: 60000 });
  if (status !== "trusted") {
    throw new Error(`Echo paste helper returned ${status || "no status"}.`);
  }
}

export function macPasteHelperPaths() {
  return {
    app: macPasteHelperApp,
    binary: macPasteHelperBinary,
    infoPlist: macPasteHelperInfoPlist
  };
}

async function hasValidMacPasteHelper() {
  try {
    await fs.access(macPasteHelperBinary);
    const plist = await fs.readFile(macPasteHelperInfoPlist, "utf8");
    if (!plist.includes(`<string>${macPasteHelperVersion}</string>`)) return false;
    await run("codesign", ["--verify", "--deep", "--strict", macPasteHelperApp]);
    return true;
  } catch {
    return false;
  }
}

async function runMacPasteHelperApp(args = [], options = {}) {
  const statusFile = path.join(
    os.tmpdir(),
    `echo-paste-helper-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.status`
  );
  await fs.rm(statusFile, { force: true }).catch(() => {});
  await run("open", ["-g", "-j", "-n", macPasteHelperApp, "--args", ...args, "--status-file", statusFile]);

  try {
    return await waitForStatusFile(statusFile, options.timeoutMs || 7000);
  } finally {
    await fs.rm(statusFile, { force: true }).catch(() => {});
  }
}

async function waitForStatusFile(file, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return (await fs.readFile(file, "utf8")).trim();
    } catch {
      await sleep(100);
    }
  }
  throw new Error("Echo paste helper did not report a result in time.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMacPasteErrors(errors) {
  const detail = errors.filter(Boolean).join(" | ");
  const permissionHint =
    `Grant Accessibility permission to ${macPasteHelperApp}, then restart the desktop agent.`;
  return [detail, permissionHint].filter(Boolean).join(" ");
}

function macPasteHelperPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Echo Paste Helper</string>
  <key>CFBundleIdentifier</key>
  <string>xyz.554119401.echo.paste-helper</string>
  <key>CFBundleName</key>
  <string>Echo Paste Helper</string>
  <key>CFBundleDisplayName</key>
  <string>Echo Paste Helper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>${macPasteHelperVersion}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
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
