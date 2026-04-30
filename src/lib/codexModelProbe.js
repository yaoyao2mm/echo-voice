import { CodexAppServerClient } from "./codexAppServerClient.js";
import { normalizeSupportedModels } from "./codexRuntime.js";

export async function probeCodexModels(options = {}) {
  const timeoutMs = Number(options.timeoutMs || 30000);
  const client = new CodexAppServerClient(options.clientOptions || {});
  try {
    await client.start();
    const result = await client.request("model/list", {}, timeoutMs);
    return normalizeModelListResponse(result);
  } finally {
    client.stop();
  }
}

export function normalizeModelListResponse(result = {}) {
  const models = Array.isArray(result?.data)
    ? result.data
    : Array.isArray(result?.models)
      ? result.models
      : Array.isArray(result)
        ? result
        : [];
  return normalizeSupportedModels(models).filter((model) => !model.hidden);
}
