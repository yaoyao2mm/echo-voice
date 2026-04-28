const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rootDir = resolveRootDir();
const settingsScript = path.join(rootDir, "scripts", "desktop-settings.js");
const desktopAgentScript = path.join(rootDir, "src", "desktop-agent.js");
const macAgentScript = path.join(rootDir, "scripts", "macos-desktop-agent.sh");
const logsDir = path.join(os.homedir(), "Library", "Logs", "EchoVoice");
const desktopAppLog = path.join(logsDir, "desktop-app.log");
const appAgentOutLog = path.join(logsDir, "desktop-agent-app.out.log");
const appAgentErrLog = path.join(logsDir, "desktop-agent-app.err.log");

let mainWindow = null;
let settingsProcess = null;
let appAgentProcess = null;
let appAgentWanted = false;
let appAgentRestartTimer = null;
let launchAgentDetected = false;
let settingsUrl = "";
let stdoutBuffer = "";
let stderrBuffer = "";
let tray = null;
let isQuitting = false;

app.setName("Echo Voice");
logApp(`starting root=${rootDir}`);

process.on("uncaughtException", (error) => {
  logApp(`uncaughtException ${error.stack || error.message}`);
  dialog.showErrorBox("Echo Voice crashed", error.message);
});

process.on("unhandledRejection", (error) => {
  const message = error?.stack || error?.message || String(error);
  logApp(`unhandledRejection ${message}`);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  logApp("single instance lock denied");
  app.quit();
} else {
  app.on("second-instance", () => {
    showSettings();
  });
}

app.whenReady().then(async () => {
  logApp("ready");
  createMenu();
  createTray();
  startSettingsServer();
  await maybeStartAppAgent();
});

app.on("activate", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else if (settingsUrl) {
    openSettingsWindow(settingsUrl);
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  appAgentWanted = false;
  stopAppAgent();
  stopSettingsServer();
});

function resolveRootDir() {
  const packagedRootFile = path.join(process.resourcesPath || "", "echo-root");
  try {
    const value = fs.readFileSync(packagedRootFile, "utf8").trim();
    if (value) return value;
  } catch {
    // Dev mode uses the repository root above desktop-app.
  }
  return path.resolve(__dirname, "..");
}

function logApp(message) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(desktopAppLog, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Logging should never prevent the desktop shell from starting.
  }
}

function startSettingsServer() {
  logApp(`starting settings service ${settingsScript}`);
  settingsProcess = spawn(process.execPath, [settingsScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ECHO_SETTINGS_HOST: "127.0.0.1",
      ECHO_SETTINGS_PORT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  settingsProcess.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const url = stdoutBuffer.match(/https?:\/\/127\.0\.0\.1:\d+\/\?key=[a-f0-9]+/i)?.[0];
    if (url && !settingsUrl) {
      settingsUrl = url;
      logApp(`settings service ready ${url.replace(/key=.*/i, "key=<redacted>")}`);
      openSettingsWindow(url);
    }
  });

  settingsProcess.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  settingsProcess.on("exit", (code) => {
    logApp(`settings service exited code=${code ?? "unknown"}`);
    if (!settingsUrl) {
      dialog.showErrorBox(
        "Echo Voice could not start",
        `The local settings service exited with code ${code ?? "unknown"}.\n\n${stderrBuffer.slice(-2000)}`
      );
      app.quit();
    }
  });
}

function stopSettingsServer() {
  if (!settingsProcess || settingsProcess.killed) return;
  settingsProcess.kill();
  settingsProcess = null;
}

function openSettingsWindow(url) {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    title: "Echo Voice",
    backgroundColor: "#f6f7f8",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(url);

  mainWindow.on("close", (event) => {
    if (isQuitting || process.platform !== "darwin") return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (process.platform !== "darwin") app.quit();
  });
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("Echo Voice");
  refreshTray();
  tray.on("click", () => showSettings());
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`Echo Voice · ${agentStatusLabel()}`);
  tray.setContextMenu(buildTrayMenu());
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: `Agent: ${agentStatusLabel()}`,
      enabled: false
    },
    {
      label: "Show Settings",
      click: () => showSettings()
    },
    {
      label: "Open In Browser",
      click: () => {
        if (settingsUrl) shell.openExternal(settingsUrl);
      }
    },
    { type: "separator" },
    {
      label: "Start App Agent",
      click: () => startAppAgent({ userInitiated: true })
    },
    {
      label: "Stop App Agent",
      enabled: Boolean(appAgentProcess),
      click: () => {
        appAgentWanted = false;
        stopAppAgent();
      }
    },
    {
      label: "Restart App Agent",
      click: () => restartAppAgent()
    },
    {
      label: "Switch From LaunchAgent To App Agent",
      click: () => switchToAppAgent()
    },
    { type: "separator" },
    {
      label: "LaunchAgent: Start",
      click: () => runAgentCommand("start")
    },
    {
      label: "LaunchAgent: Stop",
      click: () => runAgentCommand("stop")
    },
    {
      label: "LaunchAgent: Restart",
      click: () => runAgentCommand("restart")
    },
    {
      label: "Paste Helper Permission",
      click: () => runAgentCommand("paste-helper")
    },
    {
      label: "Network Doctor",
      click: () => runAgentCommand("doctor")
    },
    {
      label: "Open Logs",
      click: () => shell.openPath(logsDir)
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit()
    }
  ]);
}

function showSettings() {
  if (settingsUrl) {
    openSettingsWindow(settingsUrl);
  }
}

async function maybeStartAppAgent() {
  if (readEnvFlag("ECHO_DESKTOP_APP_AGENT", true) === false) return;
  if (process.platform === "darwin" && (await isLaunchAgentRunning())) {
    launchAgentDetected = true;
    refreshTray();
    return;
  }
  launchAgentDetected = false;
  startAppAgent();
}

function startAppAgent({ userInitiated = false } = {}) {
  if (appAgentProcess) {
    refreshTray();
    return;
  }

  appAgentWanted = true;
  fs.mkdirSync(logsDir, { recursive: true });
  const out = fs.createWriteStream(appAgentOutLog, { flags: "a" });
  const err = fs.createWriteStream(appAgentErrLog, { flags: "a" });
  const env = buildDesktopEnv({
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1"
  });

  appAgentProcess = spawn(process.execPath, [desktopAgentScript], {
    cwd: rootDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  out.write(`\n[${new Date().toISOString()}] Echo Voice app agent starting\n`);
  logApp(`app agent started pid=${appAgentProcess.pid}`);
  appAgentProcess.stdout.pipe(out);
  appAgentProcess.stderr.pipe(err);
  refreshTray();

  appAgentProcess.on("exit", (code, signal) => {
    out.write(`\n[${new Date().toISOString()}] Echo Voice app agent exited code=${code ?? ""} signal=${signal ?? ""}\n`);
    appAgentProcess = null;
    refreshTray();
    if (!isQuitting && appAgentWanted) {
      clearTimeout(appAgentRestartTimer);
      appAgentRestartTimer = setTimeout(() => startAppAgent(), 3000);
    }
  });

  appAgentProcess.on("error", (error) => {
    appAgentProcess = null;
    refreshTray();
    if (userInitiated) {
      dialog.showErrorBox("Echo app agent failed", error.message);
    }
  });
}

function stopAppAgent() {
  clearTimeout(appAgentRestartTimer);
  appAgentRestartTimer = null;
  if (!appAgentProcess || appAgentProcess.killed) {
    appAgentProcess = null;
    refreshTray();
    return;
  }
  appAgentProcess.kill("SIGTERM");
  appAgentProcess = null;
  refreshTray();
}

function restartAppAgent() {
  appAgentWanted = true;
  stopAppAgent();
  setTimeout(() => startAppAgent({ userInitiated: true }), 500);
}

function switchToAppAgent() {
  execFile("bash", [macAgentScript, "stop"], { cwd: rootDir, timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      dialog.showMessageBox({
        type: "warning",
        title: "Could not stop LaunchAgent",
        message: "Could not stop LaunchAgent",
        detail: `${stdout || ""}${stderr || error.message}`.trim().slice(-4000)
      });
    }
    startAppAgent({ userInitiated: true });
  });
}

function agentStatusLabel() {
  if (appAgentProcess) return "app agent running";
  if (appAgentWanted) return "app agent restarting";
  if (launchAgentDetected) return "LaunchAgent running";
  return "app agent stopped";
}

function isLaunchAgentRunning() {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") return resolve(false);
    execFile("launchctl", ["print", `gui/${process.getuid()}/xyz.554119401.echo.desktop-agent`], { timeout: 5000 }, (error, stdout) => {
      resolve(!error && /state = running/.test(stdout || ""));
    });
  });
}

function readEnvFlag(key, fallback) {
  const envValue = process.env[key] || readDotEnvValue(key);
  if (envValue === undefined || envValue === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(envValue).toLowerCase());
}

function readDotEnvValue(key) {
  try {
    const text = fs.readFileSync(path.join(rootDir, ".env"), "utf8");
    const match = text.match(new RegExp(`^${key}=([^\\n]*)`, "m"));
    return match?.[1]?.trim();
  } catch {
    return "";
  }
}

function buildDesktopEnv(env) {
  const home = app.getPath("home");
  return {
    ...env,
    HOME: env.HOME || home,
    USER: env.USER || process.env.USER || "",
    LOGNAME: env.LOGNAME || process.env.LOGNAME || process.env.USER || "",
    SHELL: env.SHELL || "/bin/zsh",
    CODEX_HOME: env.CODEX_HOME || path.join(home, ".codex"),
    PATH: env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: env.LANG || "en_US.UTF-8"
  };
}

function runAgentCommand(command) {
  execFile("bash", [macAgentScript, command], { cwd: rootDir, timeout: 30000 }, (error, stdout, stderr) => {
    const title = error ? `Echo ${command} failed` : `Echo ${command} finished`;
    const detail = `${stdout || ""}${stderr || ""}`.trim() || (error ? error.message : "Done.");
    dialog.showMessageBox({
      type: error ? "error" : "info",
      title,
      message: title,
      detail: detail.slice(-4000)
    });
  });
}

function createTrayIcon() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
    '<rect width="32" height="32" rx="8" fill="#0b6f6a"/>',
    '<path d="M8 17c2.3 0 2.3-8 4.6-8s2.3 14 4.6 14 2.3-10 4.6-10 2.3 4 2.3 4" fill="none" stroke="#fff" stroke-width="2.7" stroke-linecap="round"/>',
    "</svg>"
  ].join("");
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  image.setTemplateImage(false);
  return image;
}

function createMenu() {
  const template = [
    {
      label: "Echo Voice",
      submenu: [
        {
          label: "Show Settings",
          accelerator: "CommandOrControl+,",
          click: () => showSettings()
        },
        {
          label: "Open In Browser",
          click: () => {
            if (settingsUrl) shell.openExternal(settingsUrl);
          }
        },
        { type: "separator" },
        {
          label: "Start App Agent",
          click: () => startAppAgent({ userInitiated: true })
        },
        {
          label: "Stop App Agent",
          click: () => {
            appAgentWanted = false;
            stopAppAgent();
          }
        },
        {
          label: "Restart App Agent",
          click: () => restartAppAgent()
        },
        {
          label: "Switch From LaunchAgent To App Agent",
          click: () => switchToAppAgent()
        },
        {
          label: "Network Doctor",
          click: () => runAgentCommand("doctor")
        },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }]
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
