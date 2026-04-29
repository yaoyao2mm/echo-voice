#!/usr/bin/env node
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import dotenv from "dotenv";
import QRCode from "qrcode";
import { httpFetch } from "../src/lib/http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const envFile = path.join(rootDir, ".env");
const envExampleFile = path.join(rootDir, ".env.example");
const staticDir = path.join(rootDir, "desktop-settings");

dotenv.config({ path: envFile });

if (process.argv.includes("-h") || process.argv.includes("--help") || process.argv.includes("help")) {
  console.log("Usage: node scripts/desktop-settings.js [--open]");
  process.exit(0);
}

const host = process.env.ECHO_SETTINGS_HOST || "127.0.0.1";
const port = Number(process.env.ECHO_SETTINGS_PORT || 3891);
const settingsKey = crypto.randomBytes(16).toString("hex");

const fields = [
  { key: "ECHO_RELAY_URL", section: "connection", type: "text" },
  { key: "ECHO_TOKEN", section: "connection", type: "secret" },

  { key: "ECHO_PROXY_URL", section: "network", type: "text" },
  { key: "ECHO_PROXY_FALLBACK_DIRECT", section: "network", type: "boolean", defaultValue: "true" },
  { key: "ECHO_NO_PROXY", section: "network", type: "text" },
  { key: "ECHO_HTTP_TIMEOUT_MS", section: "network", type: "number", min: 1000, max: 300000 },

  {
    key: "POSTPROCESS_PROVIDER",
    section: "refine",
    type: "choice",
    choices: ["auto", "volcengine", "openai", "ollama", "rules", "none"]
  },
  { key: "METIO_VOLCENGINE_CODING_API_KEY", section: "refine", type: "secret" },
  { key: "METIO_VOLCENGINE_CODING_OPENAI_BASE_URL", section: "refine", type: "text" },
  { key: "METIO_VOLCENGINE_CODING_CHAT_MODEL", section: "refine", type: "text" },
  { key: "LLM_API_KEY", section: "refine", type: "secret" },
  { key: "LLM_BASE_URL", section: "refine", type: "text" },
  { key: "LLM_MODEL", section: "refine", type: "text" },
  { key: "OLLAMA_BASE_URL", section: "refine", type: "text" },
  { key: "OLLAMA_MODEL", section: "refine", type: "text" },

  { key: "ECHO_CODEX_ENABLED", section: "codex", type: "boolean" },
  { key: "ECHO_CODEX_WORKSPACES", section: "codex", type: "textarea" },
  { key: "ECHO_CODEX_COMMAND", section: "codex", type: "text" },
  {
    key: "ECHO_CODEX_SANDBOX",
    section: "codex",
    type: "choice",
    choices: ["workspace-write", "read-only", "danger-full-access"]
  },
  { key: "ECHO_CODEX_MODEL", section: "codex", type: "text" },
  { key: "ECHO_CODEX_PROFILE", section: "codex", type: "text" },
  { key: "ECHO_CODEX_TIMEOUT_MS", section: "codex", type: "number", min: 10000, max: 7200000 }
];

const fieldByKey = new Map(fields.map((field) => [field.key, field]));
const secretKeys = new Set(fields.filter((field) => field.type === "secret").map((field) => field.key));

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(staticDir));

app.use("/api", (req, res, next) => {
  if (req.get("x-echo-settings-key") !== settingsKey) {
    return res.status(401).json({ error: "Invalid settings key." });
  }
  next();
});

app.get("/api/state", async (req, res) => {
  try {
    const env = await readEnv();
    const health = await buildHealth(env);
    res.json({
      ok: true,
      envFile,
      fields: toPublicFields(env),
      health,
      meta: {
        platform: process.platform,
        settingsHost: host,
        settingsPort: port,
        postprocessScope: env.ECHO_RELAY_URL ? "relay server" : "local desktop"
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/config", async (req, res) => {
  try {
    const env = await readEnv();
    const updates = normalizePayload(req.body || {}, env);
    await writeEnvUpdates(updates);
    const nextEnv = await readEnv();
    res.json({
      ok: true,
      fields: toPublicFields(nextEnv)
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/test/network", async (req, res) => {
  try {
    const result = await runNodeScript(["scripts/network-doctor.js"], 20000);
    res.json({ ok: result.code === 0, ...result });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/test/refine", async (req, res) => {
  try {
    const sample =
      String(req.body?.text || "").trim() ||
      "嗯我想把手机输入的需求整理成适合 Codex 执行的任务，不要太啰嗦。";
    const env = await readEnv();
    const result = env.ECHO_RELAY_URL ? await testRelayRefine(env, sample) : await testLocalRefine(sample);
    res.json({ ok: result.code === 0, ...result });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/desktop/restart", async (req, res) => {
  try {
    const result = await runCommand("bash", ["scripts/macos-desktop-agent.sh", "restart"], 20000);
    res.json({ ok: result.code === 0, ...result });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/pairing", async (req, res) => {
  try {
    const env = await readEnv();
    const mobileUrl = buildMobileUrl(env);
    if (!mobileUrl) {
      return res.status(400).json({ error: "Set ECHO_RELAY_URL and ECHO_TOKEN before pairing." });
    }
    const qrSvg = await QRCode.toString(mobileUrl, {
      type: "svg",
      margin: 1,
      width: 260,
      color: {
        dark: "#17202a",
        light: "#ffffff"
      }
    });
    res.json({
      ok: true,
      mobileUrl,
      qrSvg
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/desktop/health", async (req, res) => {
  try {
    const env = await readEnv();
    res.json({
      ok: true,
      health: await buildHealth(env)
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/system/open", async (req, res) => {
  try {
    const target = req.body?.target || "";
    const url = systemOpenUrl(target);
    if (!url) {
      return res.status(400).json({ error: "Unknown system target." });
    }
    const result = await runCommand("open", [url], 5000);
    res.json({ ok: result.code === 0, ...result });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

const server = app.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}/?key=${settingsKey}`;
  console.log("Echo Codex desktop settings is running.");
  console.log(url);
  if (process.argv.includes("--open")) openBrowser(url);
});

server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

async function readEnv() {
  const content = await readEnvContent();
  return dotenv.parse(content);
}

async function readEnvContent() {
  try {
    return await fs.readFile(envFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  try {
    return await fs.readFile(envExampleFile, "utf8");
  } catch {
    return "";
  }
}

function toPublicFields(env) {
  const output = {};
  for (const field of fields) {
    const value = env[field.key] ?? field.defaultValue ?? "";
    output[field.key] = field.type === "secret" ? { value: "", secret: true, set: Boolean(value) } : { value };
  }
  return output;
}

function normalizePayload(body, currentEnv) {
  const values = body.values && typeof body.values === "object" ? body.values : {};
  const clearSecrets = body.clearSecrets && typeof body.clearSecrets === "object" ? body.clearSecrets : {};
  const updates = {};

  for (const [key, rawValue] of Object.entries(values)) {
    const field = fieldByKey.get(key);
    if (!field) continue;

    if (field.type === "secret") {
      if (clearSecrets[key]) {
        updates[key] = "";
      } else if (String(rawValue || "").trim()) {
        updates[key] = String(rawValue).trim();
      } else if (currentEnv[key]) {
        continue;
      } else {
        updates[key] = "";
      }
      continue;
    }

    updates[key] = normalizeValue(field, rawValue);
  }

  return updates;
}

function normalizeValue(field, rawValue) {
  if (field.type === "boolean") return rawValue === true || rawValue === "true" || rawValue === "on" ? "true" : "false";

  let value = String(rawValue ?? "").replace(/\r\n/g, "\n").trim();

  if (field.type === "choice") {
    if (!field.choices.includes(value)) {
      throw new Error(`${field.key} must be one of: ${field.choices.join(", ")}`);
    }
    return value;
  }

  if (field.type === "number") {
    if (!value) return "";
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${field.key} must be a number.`);
    if (field.min && number < field.min) throw new Error(`${field.key} must be at least ${field.min}.`);
    if (field.max && number > field.max) throw new Error(`${field.key} must be at most ${field.max}.`);
    return String(Math.round(number));
  }

  if (field.key === "ECHO_CODEX_WORKSPACES") {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .join(",");
  }

  if (field.key === "ECHO_PROXY_URL") {
    if (!value || value === "system") return value;
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("ECHO_PROXY_URL must be empty, system, or an HTTP/HTTPS proxy URL.");
    }
  }

  return value;
}

async function writeEnvUpdates(updates) {
  const content = await readEnvContent();
  const lines = content ? content.split(/\r?\n/) : [];
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)\s*=/);
    if (!match) return line;

    const key = match[1];
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return line;

    seen.add(key);
    return formatEnvLine(key, updates[key]);
  });

  const missing = Object.keys(updates).filter((key) => !seen.has(key));
  if (missing.length) {
    if (nextLines.length && nextLines[nextLines.length - 1] !== "") nextLines.push("");
    nextLines.push("# Managed by Echo desktop settings");
    for (const key of missing) nextLines.push(formatEnvLine(key, updates[key]));
  }

  await fs.writeFile(envFile, `${nextLines.join("\n").replace(/\n+$/g, "")}\n`, "utf8");
}

function formatEnvLine(key, value) {
  const text = String(value ?? "");
  if (!text) return `${key}=`;
  if (/^[A-Za-z0-9_./:@,-]+$/.test(text)) return `${key}=${text}`;
  return `${key}=${JSON.stringify(text)}`;
}

async function runNodeScript(args, timeoutMs) {
  return runCommand(process.execPath, args, timeoutMs);
}

async function testLocalRefine(sample) {
  const code = `
    import { getRefineStatus, refineTranscript } from "./src/lib/refine.js";
    const status = getRefineStatus();
    const refined = await refineTranscript({
      rawText: ${JSON.stringify(sample)},
      mode: "chat",
      contextHint: "桌面端模型配置页测试"
    });
    console.log(JSON.stringify({ scope: "local desktop", status, refined }, null, 2));
  `;
  return runNodeScript(["--input-type=module", "-e", code], 45000);
}

async function testRelayRefine(env, sample) {
  if (!env.ECHO_TOKEN) {
    return {
      code: 1,
      stdout: "",
      stderr: "Missing ECHO_TOKEN for relay refine test."
    };
  }

  try {
    const statusResponse = await httpFetch(`${trimTrailingSlash(env.ECHO_RELAY_URL)}/api/agent/ping`, {
      headers: {
        "X-Echo-Token": env.ECHO_TOKEN
      },
      timeoutMs: 15000
    });
    const statusJson = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok) {
      return {
        code: statusResponse.status,
        stdout: "",
        stderr: `Relay status failed: ${statusResponse.status} ${statusJson.error || statusResponse.statusText}`
      };
    }

    const refineResponse = await httpFetch(`${trimTrailingSlash(env.ECHO_RELAY_URL)}/api/agent/refine`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Echo-Token": env.ECHO_TOKEN
      },
      body: JSON.stringify({
        rawText: sample,
        mode: "chat",
        contextHint: "桌面端配置页测试实际 relay 后处理"
      }),
      timeoutMs: 45000
    });
    const refineJson = await refineResponse.json().catch(() => ({}));
    if (!refineResponse.ok) {
      return {
        code: refineResponse.status,
        stdout: "",
        stderr: `Relay refine failed: ${refineResponse.status} ${refineJson.error || refineResponse.statusText}`
      };
    }

    return {
      code: 0,
      stdout: JSON.stringify(
        {
          scope: "relay server",
          status: refineJson.status || statusJson.refine,
          refined: refineJson.refined || ""
        },
        null,
        2
      ),
      stderr: ""
    };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: error.message
    };
  }
}

async function runCommand(command, args, timeoutMs) {
  const env = await readEnv();
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: rootDir,
        env: { ...process.env, ...env },
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          stdout: redact(stdout || "", env),
          stderr: redact(stderr || "", env)
        });
      }
    );
  });
}

async function buildHealth(env) {
  const [agent, codex, workspaces] = await Promise.all([
    checkAgentStatus(),
    checkCodex(env),
    checkWorkspaces(env)
  ]);

  return {
    generatedAt: new Date().toISOString(),
    connection: {
      ok: Boolean(env.ECHO_RELAY_URL && env.ECHO_TOKEN),
      relayUrl: env.ECHO_RELAY_URL || "",
      tokenSet: Boolean(env.ECHO_TOKEN),
      proxy: env.ECHO_PROXY_URL || "direct"
    },
    agent,
    codex,
    workspaces
  };
}

async function checkAgentStatus() {
  if (process.platform !== "darwin") {
    const appAgent = await findDesktopAgentProcess();
    return appAgent || { ok: false, status: "unsupported", detail: "Agent status check is implemented for macOS and app-managed agents." };
  }

  const result = await runCommand("launchctl", ["print", `gui/${process.getuid()}/xyz.554119401.echo.desktop-agent`], 5000);
  const state = result.stdout.match(/state = ([^\n]+)/)?.[1]?.trim() || "";
  const pid = result.stdout.match(/\bpid = (\d+)/)?.[1] || "";
  const ok = result.code === 0 && state === "running";
  if (ok) {
    return {
      ok: true,
      status: "running",
      detail: `LaunchAgent pid ${pid || "unknown"}`
    };
  }

  const appAgent = await findDesktopAgentProcess();
  if (appAgent) return appAgent;

  return {
    ok: false,
    status: "not running",
    detail: result.stderr || result.stdout || "No LaunchAgent or app-managed agent is running."
  };
}

async function findDesktopAgentProcess() {
  const result = await runCommand("ps", ["-axo", "pid=,ppid=,args="], 5000);
  if (result.code !== 0) return null;
  const normalizedRoot = rootDir.replaceAll("\\", "/");
  const line = result.stdout
    .split(/\r?\n/)
    .find((item) => item.replaceAll("\\", "/").includes(`${normalizedRoot}/src/desktop-agent.js`));
  if (!line) return null;
  const pid = line.trim().match(/^(\d+)/)?.[1] || "unknown";
  return {
    ok: true,
    status: "running",
    detail: `app-managed pid ${pid}`
  };
}

async function checkCodex(env) {
  const command = env.ECHO_CODEX_COMMAND || "codex";
  const result = await runCommand("zsh", ["-lc", `command -v ${shellQuote(command)} && ${shellQuote(command)} --version`], 8000);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  return {
    ok: result.code === 0,
    status: result.code === 0 ? "available" : "missing",
    command,
    path: lines[0] || "",
    version: lines[1] || "",
    detail: result.code === 0 ? "" : result.stderr || result.stdout || `${command} was not found in PATH.`
  };
}

async function checkWorkspaces(env) {
  const items = parseWorkspaceList(env.ECHO_CODEX_WORKSPACES || rootDir);
  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const stat = await fs.stat(expandHome(item.path));
        return {
          ...item,
          ok: stat.isDirectory(),
          detail: stat.isDirectory() ? "directory exists" : "not a directory"
        };
      } catch (error) {
        return {
          ...item,
          ok: false,
          detail: error.message
        };
      }
    })
  );

  return {
    ok: results.length > 0 && results.every((item) => item.ok),
    items: results
  };
}

function parseWorkspaceList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [label, rawPath] = item.includes("=") ? item.split("=", 2) : ["", item];
      return {
        label: label || path.basename(rawPath) || rawPath,
        path: rawPath
      };
    });
}

function expandHome(value) {
  if (value === "~") return process.env.HOME || value;
  if (value.startsWith("~/")) return path.join(process.env.HOME || "", value.slice(2));
  return value;
}

function systemOpenUrl(target) {
  if (process.platform !== "darwin") return "";
  if (target === "login-items") return "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";
  return "";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function openBrowser(url) {
  if (process.platform !== "darwin") return;
  execFile("open", [url], () => {});
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function buildMobileUrl(env) {
  if (!env.ECHO_RELAY_URL || !env.ECHO_TOKEN) return "";
  const url = new URL(trimTrailingSlash(env.ECHO_RELAY_URL));
  url.searchParams.set("token", env.ECHO_TOKEN);
  return url.toString();
}

function redact(text, env = process.env) {
  let output = String(text || "");
  for (const key of secretKeys) {
    const value = env[key] || process.env[key];
    if (value) output = output.replaceAll(value, "<set>");
  }
  return output
    .replace(/(ECHO_TOKEN[= ]+)[^\s]+/g, "$1<set>")
    .replace(/((?:OPENAI|LLM|METIO|VOLCENGINE)[A-Z0-9_]*API_KEY[= ]+)[^\s]+/g, "$1<set>")
    .trim();
}

function handleError(res, error) {
  res.status(error.statusCode || 500).json({
    error: error.message || "Unexpected error"
  });
}
