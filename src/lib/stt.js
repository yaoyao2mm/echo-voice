import path from "node:path";
import { config } from "../config.js";

export function getSttStatus() {
  const provider = resolveSttProvider();
  return {
    provider,
    openaiConfigured: Boolean(config.stt.openaiApiKey),
    localConfigured: Boolean(config.stt.localUrl),
    model: provider === "openai" ? config.stt.openaiModel : config.stt.localModel
  };
}

export async function transcribeAudio({ buffer, mimeType, originalName }) {
  const provider = resolveSttProvider();

  if (provider === "openai") {
    return transcribeWithOpenAI({ buffer, mimeType, originalName });
  }

  if (provider === "local") {
    return transcribeWithLocalService({ buffer, mimeType, originalName });
  }

  const reason = "No speech-to-text provider configured. Set OPENAI_API_KEY or LOCAL_STT_URL.";
  const error = new Error(reason);
  error.statusCode = 503;
  throw error;
}

function resolveSttProvider() {
  if (config.stt.provider === "openai") return config.stt.openaiApiKey ? "openai" : "none";
  if (config.stt.provider === "local") return config.stt.localUrl ? "local" : "none";
  if (config.stt.provider === "none") return "none";
  if (config.stt.openaiApiKey) return "openai";
  if (config.stt.localUrl) return "local";
  return "none";
}

async function transcribeWithOpenAI({ buffer, mimeType, originalName }) {
  const form = new FormData();
  form.append("model", config.stt.openaiModel);
  form.append("response_format", "json");
  if (config.stt.language) form.append("language", config.stt.language);
  if (config.stt.prompt) form.append("prompt", config.stt.prompt);
  form.append("file", toBlob(buffer, mimeType), filename(originalName, mimeType));

  const response = await fetch(`${config.stt.openaiBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.stt.openaiApiKey}`
    },
    body: form
  });

  return parseTranscriptResponse(response, "OpenAI transcription failed");
}

async function transcribeWithLocalService({ buffer, mimeType, originalName }) {
  const form = new FormData();
  const fileField = config.stt.localFileField || "audio_file";
  form.append(fileField, toBlob(buffer, mimeType), filename(originalName, mimeType));
  if (config.stt.localModel) form.append("model", config.stt.localModel);
  if (config.stt.language) form.append("language", config.stt.language);
  if (config.stt.prompt) form.append("prompt", config.stt.prompt);

  const response = await fetch(config.stt.localUrl, {
    method: "POST",
    body: form
  });

  return parseTranscriptResponse(response, "Local transcription failed");
}

async function parseTranscriptResponse(response, prefix) {
  const contentType = response.headers.get("content-type") || "";
  const bodyText = await response.text();

  if (!response.ok) {
    const error = new Error(`${prefix}: ${response.status} ${bodyText.slice(0, 500)}`);
    error.statusCode = response.status;
    throw error;
  }

  if (contentType.includes("application/json")) {
    const json = JSON.parse(bodyText);
    return String(json.text || json.transcript || json.result || "").trim();
  }

  return bodyText.trim();
}

function toBlob(buffer, mimeType) {
  return new Blob([buffer], { type: mimeType || "audio/webm" });
}

function filename(originalName, mimeType) {
  if (originalName) return originalName;
  if (mimeType?.includes("ogg")) return "recording.ogg";
  if (mimeType?.includes("mp4")) return "recording.m4a";
  if (mimeType?.includes("wav")) return "recording.wav";
  return "recording.webm";
}
