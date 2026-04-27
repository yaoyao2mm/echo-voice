const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const settingsScript = path.join(rootDir, "scripts", "desktop-settings.js");
const macAgentScript = path.join(rootDir, "scripts", "macos-desktop-agent.sh");
const logsDir = path.join(app.getPath("home"), "Library", "Logs", "EchoVoice");

let mainWindow = null;
let settingsProcess = null;
let settingsUrl = "";
let stdoutBuffer = "";
let stderrBuffer = "";
let tray = null;
let isQuitting = false;

app.setName("Echo Voice");

app.whenReady().then(() => {
  createMenu();
  createTray();
  startSettingsServer();
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
  stopSettingsServer();
});

function startSettingsServer() {
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
      openSettingsWindow(url);
    }
  });

  settingsProcess.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  settingsProcess.on("exit", (code) => {
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
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => showSettings());
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
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
      label: "Start Agent",
      click: () => runAgentCommand("start")
    },
    {
      label: "Stop Agent",
      click: () => runAgentCommand("stop")
    },
    {
      label: "Restart Agent",
      click: () => runAgentCommand("restart")
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
          label: "Restart Agent",
          click: () => runAgentCommand("restart")
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
