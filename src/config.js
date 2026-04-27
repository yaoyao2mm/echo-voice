import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const runtimeToken = crypto.randomBytes(6).toString("hex");
const postprocessProvider = process.env.POSTPROCESS_PROVIDER || "auto";
const defaultNoProxy = "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local";
const volcengineCodingApiKey =
  process.env.METIO_VOLCENGINE_CODING_API_KEY ||
  process.env.VOLCENGINE_CODING_API_KEY ||
  (postprocessProvider === "volcengine" ? process.env.LLM_API_KEY || process.env.OPENAI_API_KEY : "") ||
  "";
const volcengineCodingBaseUrl = trimTrailingSlash(
  process.env.METIO_VOLCENGINE_CODING_OPENAI_BASE_URL ||
    process.env.VOLCENGINE_CODING_OPENAI_BASE_URL ||
    "https://ark.cn-beijing.volces.com/api/coding/v3"
);
const volcengineCodingModel =
  process.env.METIO_VOLCENGINE_CODING_CHAT_MODEL ||
  process.env.VOLCENGINE_CODING_CHAT_MODEL ||
  "ark-code-latest";
const authUsers = parseAuthUsers();

export const config = {
  host: process.env.ECHO_HOST || "0.0.0.0",
  port: Number(process.env.ECHO_PORT || 3888),
  mode: process.env.ECHO_MODE || (process.argv.includes("--relay") ? "relay" : "local"),
  publicUrl: trimTrailingSlash(process.env.ECHO_PUBLIC_URL || ""),
  relayUrl: trimTrailingSlash(process.env.ECHO_RELAY_URL || ""),
  token: process.env.ECHO_TOKEN || runtimeToken,
  dataDir: path.join(os.homedir(), ".echo-voice"),
  httpsCert: process.env.HTTPS_CERT || "",
  httpsKey: process.env.HTTPS_KEY || "",

  auth: {
    enabled: parseBoolean(process.env.ECHO_AUTH_ENABLED, authUsers.length > 0),
    users: authUsers,
    sessionSecret: process.env.ECHO_SESSION_SECRET || process.env.ECHO_TOKEN || runtimeToken,
    sessionTtlMs: Number(process.env.ECHO_SESSION_TTL_HOURS || 24 * 30) * 60 * 60 * 1000
  },

  network: {
    proxyUrl:
      process.env.ECHO_PROXY_URL ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      "",
    noProxy: process.env.ECHO_NO_PROXY || process.env.NO_PROXY || process.env.no_proxy || defaultNoProxy,
    timeoutMs: Number(process.env.ECHO_HTTP_TIMEOUT_MS || 60000)
  },

  stt: {
    provider: process.env.STT_PROVIDER || "auto",
    language: process.env.STT_LANGUAGE || "zh",
    prompt: process.env.STT_PROMPT || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiBaseUrl: trimTrailingSlash(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
    openaiModel: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    localUrl: process.env.LOCAL_STT_URL || "",
    localFileField: process.env.LOCAL_STT_FILE_FIELD || "audio_file",
    localModel: process.env.LOCAL_STT_MODEL || ""
  },

  refine: {
    provider: postprocessProvider,
    llmBaseUrl: resolveRefineBaseUrl(),
    llmApiKey: resolveRefineApiKey(),
    llmModel: resolveRefineModel(),
    volcengineConfigured: Boolean(volcengineCodingApiKey),
    volcengineBaseUrl: volcengineCodingBaseUrl,
    volcengineModel: volcengineCodingModel,
    ollamaBaseUrl: trimTrailingSlash(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"),
    ollamaModel: process.env.OLLAMA_MODEL || "qwen3:4b"
  },

  insertMode: process.env.INSERT_MODE || "paste",

  codex: {
    enabled: process.env.ECHO_CODEX_ENABLED !== "false",
    command: process.env.ECHO_CODEX_COMMAND || "codex",
    workspaces: parseWorkspaces(process.env.ECHO_CODEX_WORKSPACES || process.cwd()),
    sandbox: process.env.ECHO_CODEX_SANDBOX || "workspace-write",
    model: process.env.ECHO_CODEX_MODEL || "",
    profile: process.env.ECHO_CODEX_PROFILE || "",
    timeoutMs: Number(process.env.ECHO_CODEX_TIMEOUT_MS || 30 * 60 * 1000),
    maxEvents: Number(process.env.ECHO_CODEX_MAX_EVENTS || 500)
  }
};

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function resolveRefineBaseUrl() {
  if (postprocessProvider === "volcengine") return volcengineCodingBaseUrl;
  if (postprocessProvider === "auto" && !hasExplicitOpenAiCompatibleRefineKey() && volcengineCodingApiKey) {
    return volcengineCodingBaseUrl;
  }
  return trimTrailingSlash(process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || volcengineCodingBaseUrl || "https://api.openai.com/v1");
}

function resolveRefineApiKey() {
  if (postprocessProvider === "volcengine") return volcengineCodingApiKey;
  return process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || volcengineCodingApiKey || "";
}

function resolveRefineModel() {
  if (postprocessProvider === "volcengine") return volcengineCodingModel;
  if (postprocessProvider === "auto" && !hasExplicitOpenAiCompatibleRefineKey() && volcengineCodingApiKey) {
    return volcengineCodingModel;
  }
  return process.env.LLM_MODEL || (volcengineCodingApiKey ? volcengineCodingModel : "gpt-4.1-mini");
}

function hasExplicitOpenAiCompatibleRefineKey() {
  return Boolean(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY);
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseAuthUsers() {
  const users = [];
  if (process.env.ECHO_USERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ECHO_USERS_JSON);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const user = normalizeAuthUser(entry);
        if (user) users.push(user);
      }
    } catch (error) {
      console.warn("Could not parse ECHO_USERS_JSON:", error.message);
    }
  }

  const envUser = normalizeAuthUser({
    username: process.env.ECHO_AUTH_USERNAME,
    password: process.env.ECHO_AUTH_PASSWORD,
    passwordSha256: process.env.ECHO_AUTH_PASSWORD_SHA256,
    displayName: process.env.ECHO_AUTH_DISPLAY_NAME,
    role: process.env.ECHO_AUTH_ROLE || "owner"
  });
  if (envUser && !users.some((user) => user.username === envUser.username)) users.push(envUser);

  return users;
}

function normalizeAuthUser(entry = {}) {
  const username = String(entry.username || "").trim();
  const password = String(entry.password || "");
  const passwordSha256 = String(entry.passwordSha256 || entry.password_hash_sha256 || "").trim();
  if (!username || (!password && !passwordSha256)) return null;
  return {
    username,
    password,
    passwordSha256,
    displayName: String(entry.displayName || entry.display_name || username).trim() || username,
    role: String(entry.role || "user").trim() || "user"
  };
}

function parseWorkspaces(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [label, rawPath] = item.includes("=") ? item.split("=", 2) : ["", item];
      const workspacePath = path.resolve(expandHome(rawPath.trim()));
      return {
        id: slug(label || path.basename(workspacePath) || "workspace"),
        label: label || path.basename(workspacePath) || workspacePath,
        path: workspacePath
      };
    });
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "workspace";
}
