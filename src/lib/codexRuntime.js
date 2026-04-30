export function codexCompatibleModel(value) {
  const model = String(value || "").trim();
  return unsupportedModels().has(model) ? "" : model;
}

export function modelRequiresNewerCodex(value) {
  return unsupportedModels().has(String(value || "").trim());
}

export function listUnsupportedCodexModels() {
  return [...unsupportedModels()];
}

function unsupportedModels() {
  return new Set(
    String(process.env.ECHO_CODEX_UNSUPPORTED_MODELS || "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean)
  );
}
