#!/usr/bin/env node
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import dotenv from "dotenv";

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
  { key: "INSERT_MODE", section: "connection", type: "choice", choices: ["paste", "copy"] },

  { key: "ECHO_PROXY_URL", section: "network", type: "text" },
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

  { key: "STT_PROVIDER", section: "stt", type: "choice", choices: ["auto", "openai", "local", "none"] },
  { key: "STT_LANGUAGE", section: "stt", type: "text" },
  { key: "STT_PROMPT", section: "stt", type: "textarea" },
  { key: "OPENAI_API_KEY", section: "stt", type: "secret" },
  { key: "OPENAI_BASE_URL", section: "stt", type: "text" },
  { key: "OPENAI_TRANSCRIBE_MODEL", section: "stt", type: "text" },
  { key: "LOCAL_STT_URL", section: "stt", type: "text" },
  { key: "LOCAL_STT_FILE_FIELD", section: "stt", type: "text" },
  { key: "LOCAL_STT_MODEL", section: "stt", type: "text" },

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
    res.json({
      ok: true,
      envFile,
      fields: toPublicFields(env),
      meta: {
        platform: process.platform,
        settingsHost: host,
        settingsPort: port
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
      "嗯我想把这个语音输入法需求整理成适合 Codex 执行的任务，不要太啰嗦。";
    const code = `
      import { getRefineStatus, refineTranscript } from "./src/lib/refine.js";
      const status = getRefineStatus();
      const refined = await refineTranscript({
        rawText: ${JSON.stringify(sample)},
        mode: "chat",
        contextHint: "桌面端模型配置页测试"
      });
      console.log(JSON.stringify({ status, refined }, null, 2));
    `;
    const result = await runNodeScript(["--input-type=module", "-e", code], 45000);
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

app.get("*", (req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

const server = app.listen(port, host, () => {
  const url = `http://${host}:${port}/?key=${settingsKey}`;
  console.log("Echo Voice desktop settings is running.");
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
    const value = env[field.key] ?? "";
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

function openBrowser(url) {
  if (process.platform !== "darwin") return;
  execFile("open", [url], () => {});
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
