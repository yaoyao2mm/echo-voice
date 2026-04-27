const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const settingsScript = path.join(rootDir, "scripts", "desktop-settings.js");

let mainWindow = null;
let settingsProcess = null;
let settingsUrl = "";
let stdoutBuffer = "";
let stderrBuffer = "";

app.setName("Echo Voice");

app.whenReady().then(() => {
  createMenu();
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

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (process.platform !== "darwin") app.quit();
  });
}

function createMenu() {
  const template = [
    {
      label: "Echo Voice",
      submenu: [
        {
          label: "Show Settings",
          accelerator: "CommandOrControl+,",
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
            } else if (settingsUrl) {
              openSettingsWindow(settingsUrl);
            }
          }
        },
        {
          label: "Open In Browser",
          click: () => {
            if (settingsUrl) shell.openExternal(settingsUrl);
          }
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
