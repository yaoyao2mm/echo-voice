const cliUpgradeOnlyModels = new Set(["gpt-5.5"]);

export function codexCompatibleModel(value) {
  const model = String(value || "").trim();
  return cliUpgradeOnlyModels.has(model) ? "" : model;
}

export function modelRequiresNewerCodex(value) {
  return cliUpgradeOnlyModels.has(String(value || "").trim());
}
