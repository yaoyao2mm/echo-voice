import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const runtimeToken = crypto.randomBytes(6).toString("hex");

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
    provider: process.env.POSTPROCESS_PROVIDER || "auto",
    llmBaseUrl: trimTrailingSlash(process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"),
    llmApiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "",
    llmModel: process.env.LLM_MODEL || "gpt-4.1-mini",
    ollamaBaseUrl: trimTrailingSlash(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"),
    ollamaModel: process.env.OLLAMA_MODEL || "qwen3:4b"
  },

  insertMode: process.env.INSERT_MODE || "paste"
};

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
