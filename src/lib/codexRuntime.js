const permissionPresets = {
  strict: { sandbox: "read-only", approvalPolicy: "on-request" },
  approve: { sandbox: "workspace-write", approvalPolicy: "on-request" },
  full: { sandbox: "danger-full-access", approvalPolicy: "never" }
};

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

export function normalizeSupportedModels(models = []) {
  return Array.isArray(models)
    ? models
        .map((model) => {
          const id = String(model?.id || model?.model || "").trim();
          if (!id) return null;
          const supportedReasoningEfforts = normalizeReasoningEfforts(model.supportedReasoningEfforts);
          return {
            id,
            model: String(model?.model || id).trim() || id,
            displayName: String(model?.displayName || model?.display_name || id).trim() || id,
            description: String(model?.description || "").trim(),
            hidden: Boolean(model?.hidden),
            isDefault: Boolean(model?.isDefault || model?.is_default),
            inputModalities: Array.isArray(model?.inputModalities)
              ? model.inputModalities.map((item) => String(item || "").trim()).filter(Boolean)
              : [],
            supportedReasoningEfforts,
            defaultReasoningEffort: normalizeReasoningEffort(model?.defaultReasoningEffort || model?.default_reasoning_effort)
          };
        })
        .filter(Boolean)
    : [];
}

export function normalizeAllowedPermissionModes(value = undefined) {
  const raw = value === undefined ? process.env.ECHO_CODEX_ALLOWED_PERMISSION_MODES || "strict,approve,full" : value;
  const modes = (Array.isArray(raw) ? raw : String(raw || "").split(","))
    .map((mode) => normalizePermissionMode(mode))
    .filter(Boolean);
  return Array.from(new Set(modes));
}

export function normalizePermissionMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "readonly" || normalized === "read-only" || normalized === "suggest") return "strict";
  if (normalized === "approved" || normalized === "auto" || normalized === "auto-edit") return "approve";
  if (normalized === "full-auto" || normalized === "fullaccess" || normalized === "danger-full-access") return "full";
  return permissionPresets[normalized] ? normalized : "";
}

export function permissionModeFromRuntime(runtime = {}) {
  const explicit = normalizePermissionMode(runtime.permissionMode || runtime.permissionsMode || runtime.profile);
  if (explicit) return explicit;

  const sandbox = normalizeSandboxModeValue(runtime.sandbox);
  const approvalPolicy = String(runtime.approvalPolicy || "").trim().toLowerCase();
  if (sandbox === "read-only") return "strict";
  if (sandbox === "danger-full-access" && (!approvalPolicy || approvalPolicy === "never")) return "full";
  if (sandbox === "workspace-write") return "approve";
  return "";
}

export function permissionPresetForMode(mode) {
  const normalized = normalizePermissionMode(mode);
  return normalized ? permissionPresets[normalized] : { sandbox: "", approvalPolicy: "" };
}

export function sanitizeRuntimeForAgent(requestedRuntime = {}, agentRuntime = {}) {
  const normalizedAgent = agentRuntime && typeof agentRuntime === "object" ? agentRuntime : {};
  const requested = requestedRuntime && typeof requestedRuntime === "object" ? requestedRuntime : {};
  const allowedModes = normalizeAllowedPermissionModes(
    Array.isArray(normalizedAgent.allowedPermissionModes) && normalizedAgent.allowedPermissionModes.length > 0
      ? normalizedAgent.allowedPermissionModes
      : undefined
  );
  const requestedMode = permissionModeFromRuntime(requested);
  const fallbackMode = permissionModeFromRuntime(normalizedAgent);
  const useRequestedMode = allowedModes.includes(requestedMode);
  const useFallbackMode = !useRequestedMode && requestedMode && allowedModes.includes(fallbackMode);
  const permissionMode = useRequestedMode ? requestedMode : useFallbackMode ? fallbackMode : "";
  const preset = permissionPresetForMode(permissionMode);
  const desktopDefault = desktopPermissionDefault(normalizedAgent);
  const sandbox = permissionMode ? preset.sandbox : desktopDefault.sandbox || permissionPresetForMode(allowedModes[0] || "").sandbox;
  const approvalPolicy = permissionMode
    ? preset.approvalPolicy
    : desktopDefault.approvalPolicy || permissionPresetForMode(allowedModes[0] || "").approvalPolicy;
  const supportedModels = normalizeSupportedModels(normalizedAgent.supportedModels);
  const supportedModelIds = new Set(supportedModels.map((model) => model.id));
  const unsupportedModelIds = new Set(
    Array.isArray(normalizedAgent.unsupportedModels)
      ? normalizedAgent.unsupportedModels.map((model) => String(model || "").trim()).filter(Boolean)
      : []
  );
  const model = sanitizeModel(requested.model, { supportedModelIds, unsupportedModelIds, hasSupportedModelList: supportedModels.length > 0 });
  const reasoningEffort = sanitizeReasoningEffort(requested.reasoningEffort || requested.effort, model || normalizedAgent.model, supportedModels);

  return {
    command: "",
    sandbox,
    approvalPolicy,
    model,
    unsupportedModels: [],
    reasoningEffort,
    profile: permissionMode,
    permissionMode,
    timeoutMs: Number(requested.timeoutMs || 0) || null
  };
}

export function normalizeReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["low", "medium", "high", "xhigh"].includes(normalized) ? normalized : "";
}

function unsupportedModels() {
  return new Set(
    String(process.env.ECHO_CODEX_UNSUPPORTED_MODELS || "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean)
  );
}

function normalizeSandboxModeValue(value) {
  const normalized = String(value || "").trim();
  if (normalized === "workspaceWrite") return "workspace-write";
  if (normalized === "dangerFullAccess") return "danger-full-access";
  if (normalized === "readOnly") return "read-only";
  return normalized;
}

function desktopPermissionDefault(runtime = {}) {
  const sandbox = normalizeSandboxModeValue(runtime.sandbox);
  const approvalPolicy = String(runtime.approvalPolicy || "").trim().toLowerCase();
  if (!sandbox && !approvalPolicy) return { sandbox: "", approvalPolicy: "" };
  return {
    sandbox: sandbox || "workspace-write",
    approvalPolicy: approvalPolicy || "on-request"
  };
}

function normalizeReasoningEfforts(value = []) {
  return Array.isArray(value)
    ? value
        .map((item) => normalizeReasoningEffort(item?.reasoningEffort || item?.value || item))
        .filter(Boolean)
    : [];
}

function sanitizeModel(value, { supportedModelIds, unsupportedModelIds, hasSupportedModelList }) {
  const model = codexCompatibleModel(value);
  if (!model) return "";
  if (unsupportedModelIds.has(model)) return "";
  if (hasSupportedModelList && !supportedModelIds.has(model)) return "";
  return model;
}

function sanitizeReasoningEffort(value, model, supportedModels) {
  const reasoningEffort = normalizeReasoningEffort(value);
  if (!reasoningEffort) return "";
  const modelInfo = supportedModels.find((item) => item.id === model || item.model === model);
  if (!modelInfo || modelInfo.supportedReasoningEfforts.length === 0) return reasoningEffort;
  return modelInfo.supportedReasoningEfforts.includes(reasoningEffort) ? reasoningEffort : "";
}
