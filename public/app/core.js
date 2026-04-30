const MAX_COMPOSER_ATTACHMENTS = 3;
const MAX_COMPOSER_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CONTEXT_TOKEN_LIMIT = 128000;
const ATTACHMENT_CONTEXT_TOKEN_ESTIMATE = 1200;
const AUTO_COMPACT_CONTEXT_PERCENT = 85;

const MODEL_OPTIONS = [
  { value: "", label: "桌面默认" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { value: "gpt-5.2-codex", label: "GPT-5.2-Codex" }
];

const REASONING_OPTIONS = [
  { value: "", label: "桌面默认" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" }
];

const PERMISSION_MODE_OPTIONS = [
  { value: "", label: "默认" },
  { value: "strict", label: "严格" },
  { value: "approve", label: "批准" },
  { value: "full", label: "全权限" }
];

export function createAppContext(windowRef = window, documentRef = document) {
  const params = new URLSearchParams(windowRef.location.search);
  const tokenFromUrl = params.get("token");
  if (tokenFromUrl) {
    windowRef.localStorage.setItem("echoToken", tokenFromUrl);
    windowRef.history.replaceState({}, "", windowRef.location.pathname);
  }

  return {
    window: windowRef,
    document: documentRef,
    navigator: windowRef.navigator,
    localStorage: windowRef.localStorage,
    crypto: windowRef.crypto,
    constants: {
      MAX_COMPOSER_ATTACHMENTS,
      MAX_COMPOSER_ATTACHMENT_BYTES,
      MODEL_OPTIONS,
      REASONING_OPTIONS,
      PERMISSION_MODE_OPTIONS
    },
    elements: queryElements(documentRef),
    state: {
      token: tokenFromUrl || windowRef.localStorage.getItem("echoToken") || "",
      sessionToken: windowRef.localStorage.getItem("echoSession") || "",
      currentUser: readStoredUser(windowRef.localStorage),
      authEnabled: true,
      themeMode: windowRef.localStorage.getItem("echoTheme") === "dark" ? "dark" : "light",
      codexTimer: null,
      pairingStream: null,
      pairingScanActive: false,
      pairingScanBusy: false,
      selectedCodexJobId: "",
      selectedCodexSession: null,
      sessionEventSource: null,
      sessionEventSourceId: "",
      sessionListRefreshTimer: null,
      composingNewSession: false,
      codexWorkspaces: [],
      codexAgentOnline: false,
      projectCreateBusy: false,
      showArchivedSessions: false,
      composerBusy: false,
      codexAgentRuntime: {},
      codexUnsupportedModels: [],
      codexSupportedModels: [],
      codexAllowedPermissionModes: [],
      runtimePreferences: readStoredRuntimePreferences(windowRef.localStorage),
      runtimeDirty: false,
      lastTopbarScrollY: 0,
      topbarScrollAccumulator: 0,
      topbarCollapsed: false,
      renderedCodexSessionId: "",
      renderedCodexSessionSignature: "",
      composerAttachments: [],
      composerAttachmentPendingCount: 0,
      composerPlanMode: windowRef.localStorage.getItem("echoComposerMode") === "plan",
      autoCompactedSessionIds: new Set()
    }
  };
}

export function installCore(app) {
  const { document, elements, localStorage, state, window } = app;
  const { MODEL_OPTIONS: modelOptions, PERMISSION_MODE_OPTIONS: permissionOptions, REASONING_OPTIONS: reasoningOptions } =
    app.constants;

  app.bindViewportMetrics = function bindViewportMetrics() {
    app.syncViewportMetrics();
    window.addEventListener("resize", app.syncViewportMetrics, { passive: true });
    window.visualViewport?.addEventListener("resize", app.syncViewportMetrics, { passive: true });
    window.visualViewport?.addEventListener("scroll", app.syncViewportMetrics, { passive: true });
  };

  app.syncViewportMetrics = function syncViewportMetrics() {
    const viewport = window.visualViewport;
    const nextHeight = Math.round(viewport?.height || window.innerHeight || 0);
    if (nextHeight > 0) {
      document.documentElement.style.setProperty("--app-height", `${nextHeight}px`);
    }
    document.body.classList.toggle("mobile-ui", app.usesCompactTopbarMode());
    document.body.classList.toggle("desktop-ui", !app.usesCompactTopbarMode());
    if (elements.topbar) {
      document.documentElement.style.setProperty("--topbar-height", `${Math.round(elements.topbar.offsetHeight || 0)}px`);
    }
    app.syncComposerInputHeight();
    app.syncComposerMetrics();
  };

  app.queueViewportSync = function queueViewportSync() {
    window.requestAnimationFrame(() => {
      app.syncViewportMetrics();
    });
  };

  app.applyThemeMode = function applyThemeMode(themeMode, options = {}) {
    const mode = themeMode === "dark" ? "dark" : "light";
    const isDark = mode === "dark";
    state.themeMode = mode;
    if (isDark) {
      document.documentElement.dataset.theme = "dark";
    } else {
      delete document.documentElement.dataset.theme;
    }
    document.body.classList.toggle("theme-dark", isDark);
    if (elements.themeModeToggle) {
      elements.themeModeToggle.checked = isDark;
      elements.themeModeToggle.setAttribute("aria-checked", isDark ? "true" : "false");
    }
    if (elements.themeColorMeta) {
      elements.themeColorMeta.setAttribute("content", isDark ? "#0d1014" : "#f5f6f8");
    }
    if (elements.appleStatusBarMeta) {
      elements.appleStatusBarMeta.setAttribute("content", isDark ? "black-translucent" : "default");
    }
    if (options.persist !== false) {
      localStorage.setItem("echoTheme", mode);
    }
  };

  app.toggleThemeMode = function toggleThemeMode() {
    app.applyThemeMode(elements.themeModeToggle?.checked ? "dark" : "light");
  };

  app.bindTopbarScrollState = function bindTopbarScrollState() {
    app.resetTopbarScrollTracking({ forceVisible: true });
    elements.codexScrollSurface?.addEventListener(
      "scroll",
      () => {
        app.syncTopbarVisibility();
      },
      { passive: true }
    );
    window.addEventListener(
      "scroll",
      () => {
        app.syncTopbarVisibility();
      },
      { passive: true }
    );
    window.addEventListener(
      "resize",
      () => {
        app.resetTopbarScrollTracking({ forceVisible: true });
      },
      { passive: true }
    );
  };

  app.resetTopbarScrollTracking = function resetTopbarScrollTracking(options = {}) {
    state.lastTopbarScrollY = app.currentTopbarScrollY();
    state.topbarScrollAccumulator = 0;
    if (options.forceVisible) {
      app.setTopbarCollapsed(false);
    }
  };

  app.syncTopbarVisibility = function syncTopbarVisibility(options = {}) {
    if (!app.usesCompactTopbarMode()) {
      app.resetTopbarScrollTracking({ forceVisible: true });
      return;
    }

    const currentY = app.currentTopbarScrollY();
    const delta = currentY - state.lastTopbarScrollY;
    state.lastTopbarScrollY = currentY;
    if (options.forceVisible || currentY <= 8 || elements.codexView.classList.contains("sessions-open")) {
      state.topbarScrollAccumulator = 0;
      app.setTopbarCollapsed(false);
      return;
    }
    if (app.isConversationScrolledToBottom()) {
      state.topbarScrollAccumulator = 0;
      return;
    }
    if (Math.abs(delta) < 1) return;
    if (state.topbarScrollAccumulator && Math.sign(state.topbarScrollAccumulator) !== Math.sign(delta)) {
      state.topbarScrollAccumulator = delta;
    } else {
      state.topbarScrollAccumulator += delta;
    }
    if (state.topbarScrollAccumulator >= 18) {
      state.topbarScrollAccumulator = 0;
      app.setTopbarCollapsed(true);
    } else if (state.topbarScrollAccumulator <= -10) {
      state.topbarScrollAccumulator = 0;
      app.setTopbarCollapsed(false);
    }
  };

  app.currentTopbarScrollY = function currentTopbarScrollY() {
    if (app.usesCompactTopbarMode()) {
      return Math.max(window.scrollY || 0, elements.codexScrollSurface?.scrollTop || 0, 0);
    }
    return Math.max(window.scrollY || 0, 0);
  };

  app.isConversationScrolledToBottom = function isConversationScrolledToBottom() {
    if (!app.usesCompactTopbarMode()) return false;
    const surface = elements.codexScrollSurface;
    if (!surface || surface.hidden) return false;
    const distanceToBottom = surface.scrollHeight - surface.clientHeight - surface.scrollTop;
    return distanceToBottom <= 32;
  };

  app.usesCompactTopbarMode = function usesCompactTopbarMode() {
    return window.matchMedia("(max-width: 760px)").matches && !elements.codexView.hidden;
  };

  app.setTopbarCollapsed = function setTopbarCollapsed(collapsed) {
    if (state.topbarCollapsed === collapsed) return;
    state.topbarCollapsed = collapsed;
    document.body.classList.toggle("topbar-collapsed", collapsed);
  };

  app.syncComposerMetrics = function syncComposerMetrics() {
    const composerHeight = Math.round(elements.composer?.offsetHeight || 0);
    if (composerHeight > 0) {
      document.documentElement.style.setProperty("--composer-height", `${composerHeight}px`);
    }
  };

  app.syncComposerInputHeight = function syncComposerInputHeight() {
    const textarea = elements.codexPrompt;
    if (!textarea) return;
    const maxHeight = app.usesCompactTopbarMode() ? 132 : 168;
    const minHeight = app.usesCompactTopbarMode() ? 56 : 52;
    textarea.style.height = "auto";
    const nextHeight = Math.max(textarea.scrollHeight, minHeight);
    textarea.style.height = `${Math.min(nextHeight, maxHeight)}px`;
    textarea.style.overflowY = nextHeight > maxHeight ? "auto" : "hidden";
  };

  app.refreshComposerStatusBar = function refreshComposerStatusBar() {
    if (!elements.composerStatusText) return;

    const session = state.composingNewSession ? null : state.selectedCodexSession;
    let status = "";
    if (state.composerBusy) {
      status = "正在发送…";
    } else if (state.composerAttachmentPendingCount > 0) {
      status =
        state.composerAttachmentPendingCount === 1
          ? "正在处理 1 张图片…"
          : `正在处理 ${state.composerAttachmentPendingCount} 张图片…`;
    } else if (!elements.codexProject.value) {
      status = "先选择工程";
    } else if (session?.pendingApprovalCount > 0) {
      status = "等待你的审批";
    } else if (session?.status === "starting") {
      status = "Codex 正在启动";
    } else if (session?.status === "running") {
      status = "Codex 正在回复";
    } else if (session?.pendingCommandCount > 0) {
      status = "消息已排队";
    } else if (session?.status === "failed" && app.sessionCanRecoverFailure(session)) {
      status = "上次中断，可继续";
    } else if (session && !app.sessionCanAcceptFollowUp(session)) {
      status = "当前会话不可继续";
    }
    elements.composerStatusText.textContent = status;
    elements.composerStatusText.classList.toggle("is-empty", !status);
    app.refreshContextUsageIndicator();
  };

  app.refreshContextUsageIndicator = function refreshContextUsageIndicator() {
    const indicator = elements.contextUsageIndicator;
    if (!indicator) return;

    const usage = app.estimateContextUsage();
    const rawPercent = usage.limitTokens > 0 ? Math.round((usage.estimatedTokens / usage.limitTokens) * 100) : 0;
    const percent = Math.max(0, Math.min(100, rawPercent));
    const visiblePercent = usage.estimatedTokens > 0 ? Math.max(1, percent) : 0;
    const stateName = percent >= AUTO_COMPACT_CONTEXT_PERCENT ? "full" : percent >= 65 ? "warn" : "normal";
    const label = `上下文使用约 ${percent}% · 估算 ${usage.estimatedTokens.toLocaleString("zh-CN")} / ${usage.limitTokens.toLocaleString("zh-CN")} tokens`;

    indicator.style.setProperty("--context-used", `${visiblePercent}%`);
    indicator.dataset.state = stateName;
    indicator.title = label;
    indicator.setAttribute("aria-label", label);
    indicator.setAttribute("aria-valuenow", String(percent));
    app.maybeAutoCompactContext?.(usage, percent);
  };

  app.estimateContextUsage = function estimateContextUsage() {
    const session = state.composingNewSession ? null : state.selectedCodexSession;
    const parts = [];
    let attachmentCount = 0;

    for (const message of session?.messages || []) {
      if (message?.text) parts.push(message.text);
      attachmentCount += Array.isArray(message?.attachments) ? message.attachments.length : 0;
    }
    if ((!session?.messages || session.messages.length === 0) && Array.isArray(session?.events)) {
      for (const event of session.events) {
        if (event?.text) parts.push(event.text);
      }
    }
    if (session?.finalMessage) parts.push(session.finalMessage);
    if (elements.codexPrompt?.value) parts.push(elements.codexPrompt.value);
    attachmentCount += state.composerAttachments.length;

    const textTokens = app.estimateTextTokens(parts.join("\n"));
    const estimatedTokens = textTokens + attachmentCount * ATTACHMENT_CONTEXT_TOKEN_ESTIMATE;
    return {
      estimatedTokens,
      limitTokens: app.contextTokenLimit()
    };
  };

  app.estimateTextTokens = function estimateTextTokens(value) {
    const text = String(value || "");
    if (!text) return 0;
    const cjkMatches = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || [];
    const cjkCount = cjkMatches.length;
    const nonCjkLength = text.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, "").replace(/\s+/g, " ").trim().length;
    return cjkCount + Math.ceil(nonCjkLength / 4);
  };

  app.contextTokenLimit = function contextTokenLimit() {
    return DEFAULT_CONTEXT_TOKEN_LIMIT;
  };

  app.setTopbarStatus = function setTopbarStatus(label, indicatorState = "idle") {
    const text = String(label || "");
    if (elements.statusText) {
      elements.statusText.textContent = text;
    }
    if (elements.mobileStatusIndicator) {
      elements.mobileStatusIndicator.dataset.state = indicatorState;
      elements.mobileStatusIndicator.title = text;
      elements.mobileStatusIndicator.setAttribute("aria-label", text);
    }
  };

  app.initRuntimeControls = function initRuntimeControls() {
    app.populateRuntimeSelect(elements.codexPermissionMode, permissionOptions);
    app.populateRuntimeSelect(elements.codexModel, modelOptions);
    app.populateRuntimeSelect(elements.codexReasoningEffort, reasoningOptions);
    app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
    app.refreshRuntimeDefaultOptions();
  };

  app.populateRuntimeSelect = function populateRuntimeSelect(select, options) {
    select.innerHTML = "";
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      node.dataset.baseLabel = option.label;
      select.append(node);
    }
  };

  app.handleRuntimeControlChange = function handleRuntimeControlChange() {
    if (app.permissionModeUnavailable(elements.codexPermissionMode.value)) {
      elements.codexPermissionMode.value = "";
      app.toast("当前桌面端策略不支持这个权限模式，已切回桌面默认。");
    }
    if (app.modelRequiresNewerCodex(elements.codexModel.value)) {
      elements.codexModel.value = "";
      app.toast("当前桌面端 Codex 版本不支持这个模型，已切回桌面默认。");
    }
    state.runtimeDirty = true;
    state.runtimePreferences = app.currentRuntimeDraft();
    app.writeStoredRuntimePreferences(state.runtimePreferences);
    app.refreshActiveSessionHeader();
    app.refreshComposerMeta();
  };

  app.currentRuntimeDraft = function currentRuntimeDraft() {
    const next = app.normalizeRuntimeChoice({
      permissionMode: elements.codexPermissionMode.value,
      model: elements.codexModel.value,
      reasoningEffort: elements.codexReasoningEffort.value
    });
    const preset = app.permissionRuntimeForMode(next.permissionMode);
    return {
      ...next,
      profile: next.permissionMode || "",
      sandbox: next.permissionMode ? preset.sandbox : "",
      approvalPolicy: next.permissionMode ? preset.approvalPolicy : ""
    };
  };

  app.runtimeChoiceWithFallback = function runtimeChoiceWithFallback(runtime = {}, fallback = state.runtimePreferences) {
    const next = app.normalizeRuntimeChoice(runtime);
    const base = app.normalizeRuntimeChoice(fallback);
    const permissionMode = next.permissionMode || base.permissionMode;
    const preset = app.permissionRuntimeForMode(permissionMode);
    return {
      permissionMode,
      sandbox: permissionMode ? preset.sandbox : next.sandbox || base.sandbox,
      approvalPolicy: permissionMode ? preset.approvalPolicy : next.approvalPolicy || base.approvalPolicy,
      model: next.model || base.model,
      reasoningEffort: next.reasoningEffort || base.reasoningEffort
    };
  };

  app.applyRuntimeDraft = function applyRuntimeDraft(runtime = {}, options = {}) {
    const next = app.normalizeRuntimeChoice(runtime);
    app.ensureRuntimeOption(
      elements.codexPermissionMode,
      permissionOptions,
      next.permissionMode,
      app.permissionModeDisplayName(next.permissionMode)
    );
    app.ensureRuntimeOption(elements.codexModel, modelOptions, next.model, app.modelDisplayName(next.model));
    app.ensureRuntimeOption(
      elements.codexReasoningEffort,
      reasoningOptions,
      next.reasoningEffort,
      app.reasoningDisplayName(next.reasoningEffort)
    );
    elements.codexPermissionMode.value = next.permissionMode;
    elements.codexModel.value = next.model;
    elements.codexReasoningEffort.value = next.reasoningEffort;
    state.runtimeDirty = Boolean(options.dirty);
    if (options.persist !== false) {
      state.runtimePreferences = next;
      app.writeStoredRuntimePreferences(next);
    }
    app.refreshRuntimeDefaultOptions();
  };

  app.refreshRuntimeDefaultOptions = function refreshRuntimeDefaultOptions() {
    const permissionOption = elements.codexPermissionMode.querySelector('option[value=""]');
    const modelOption = elements.codexModel.querySelector('option[value=""]');
    const reasoningOption = elements.codexReasoningEffort.querySelector('option[value=""]');
    if (permissionOption) {
      permissionOption.textContent = state.codexAgentRuntime.permissionMode
        ? `默认 · ${app.permissionModeDisplayName(state.codexAgentRuntime.permissionMode)}`
        : "默认";
    }
    if (modelOption) {
      modelOption.textContent = state.codexAgentRuntime.model
        ? `默认 · ${app.modelDisplayName(state.codexAgentRuntime.model)}`
        : "默认";
    }
    if (reasoningOption) {
      reasoningOption.textContent = state.codexAgentRuntime.reasoningEffort
        ? `默认 · ${app.reasoningDisplayName(state.codexAgentRuntime.reasoningEffort)}`
        : "默认";
    }
    app.refreshModelOptionAvailability();
    app.refreshPermissionModeAvailability();
  };

  app.refreshModelOptionAvailability = function refreshModelOptionAvailability() {
    for (const model of state.codexSupportedModels || []) {
      app.ensureRuntimeOption(elements.codexModel, modelOptions, model.id, model.displayName || model.id);
    }
    for (const option of Array.from(elements.codexModel.options || [])) {
      const value = String(option.value || "").trim();
      if (!value) continue;
      const unsupported = app.modelRequiresNewerCodex(value);
      option.disabled = unsupported;
      option.textContent = unsupported ? `${option.dataset.baseLabel || option.textContent} · 需升级桌面 Codex` : option.dataset.baseLabel || option.textContent;
    }
  };

  app.refreshPermissionModeAvailability = function refreshPermissionModeAvailability() {
    for (const option of Array.from(elements.codexPermissionMode.options || [])) {
      const value = String(option.value || "").trim();
      if (!value) continue;
      const unavailable = app.permissionModeUnavailable(value);
      option.disabled = unavailable;
      option.textContent = unavailable ? `${option.dataset.baseLabel || option.textContent} · 桌面未开放` : option.dataset.baseLabel || option.textContent;
    }
  };

  app.ensureRuntimeOption = function ensureRuntimeOption(select, options, value, fallbackLabel) {
    if (!value) return;
    const known = options.some((option) => option.value === value);
    const existing = Array.from(select.options).find((option) => option.value === value);
    if (known || existing) return;
    const node = document.createElement("option");
    node.value = value;
    node.textContent = fallbackLabel || value;
    select.append(node);
  };

  app.normalizeRuntimeChoice = function normalizeRuntimeChoice(runtime = {}) {
    const knownModelValues = new Set(modelOptions.map((option) => option.value));
    const knownReasoningValues = new Set(reasoningOptions.map((option) => option.value));
    const permissionMode = app.normalizePermissionMode(
      runtime.permissionMode || runtime.permissionsMode || runtime.profile || app.permissionModeFromRuntime(runtime)
    );
    const rawModel = String(runtime.model || "").trim();
    const model = app.modelRequiresNewerCodex(rawModel) ? "" : rawModel;
    const reasoningEffort = String(runtime.reasoningEffort || runtime.effort || "").trim().toLowerCase();
    return {
      permissionMode: app.permissionModeUnavailable(permissionMode) ? "" : permissionMode,
      sandbox: app.normalizeSandboxModeValue(runtime.sandbox),
      approvalPolicy: app.normalizeApprovalPolicyValue(runtime.approvalPolicy),
      model: knownModelValues.has(model) || model ? model : "",
      reasoningEffort: knownReasoningValues.has(reasoningEffort) || reasoningEffort ? reasoningEffort : ""
    };
  };

  app.writeStoredRuntimePreferences = function writeStoredRuntimePreferences(runtime = {}) {
    const next = app.normalizeRuntimeChoice(runtime);
    if (next.permissionMode) localStorage.setItem("echoCodexPermissionMode", next.permissionMode);
    else localStorage.removeItem("echoCodexPermissionMode");
    if (next.model) localStorage.setItem("echoCodexModel", next.model);
    else localStorage.removeItem("echoCodexModel");
    if (next.reasoningEffort) localStorage.setItem("echoCodexReasoningEffort", next.reasoningEffort);
    else localStorage.removeItem("echoCodexReasoningEffort");
  };

  app.workspaceLabel = function workspaceLabel(workspace) {
    return workspace?.label || workspace?.id || workspace?.path || "未命名项目";
  };

  app.workspaceMeta = function workspaceMeta(workspace) {
    return workspace?.path || workspace?.id || "桌面端已同步";
  };

  app.workspaceSecondaryLabel = function workspaceSecondaryLabel(workspace) {
    if (!workspace?.id) return "";
    return workspace.label && workspace.label !== workspace.id ? workspace.id : "";
  };

  app.workspacePathLabel = function workspacePathLabel(workspace) {
    if (!workspace?.path) return "";
    return workspace.path !== workspace.id ? workspace.path : "";
  };

  app.workspaceDirectoryName = function workspaceDirectoryName(workspace) {
    const pathLabel = String(workspace?.path || "").trim().replace(/[/\\]+$/g, "");
    const directoryName = pathLabel.split(/[/\\]/).filter(Boolean).pop();
    return directoryName || workspace?.label || workspace?.id || "未命名工程";
  };

  app.refreshTopbarProjectChip = function refreshTopbarProjectChip() {
    if (!elements.topbarProjectChip || !elements.projectSwitcher) return;
    const label = String(elements.composerProjectLabel?.textContent || "").trim();
    const hide = !app.isLoggedIn() || !state.token || !label;
    elements.projectSwitcher.hidden = hide;
    elements.topbarProjectChip.title = label ? `当前工程：${label}` : "切换工程";
  };

  app.formatRelativeTime = function formatRelativeTime(value) {
    if (!value) return "刚刚";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "刚刚";
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return "刚刚";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  };

  app.formatMessageTime = function formatMessageTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  };

  app.sessionProjectLabel = function sessionProjectLabel(projectId) {
    const normalizedProjectId = String(projectId || "").trim();
    if (!normalizedProjectId) return "未选择工程";
    return app.workspaceLabel(
      state.codexWorkspaces.find((workspace) => workspace.id === normalizedProjectId) || { id: normalizedProjectId }
    );
  };

  app.sessionRuntimeLabel = function sessionRuntimeLabel(runtime = {}) {
    const normalized = app.normalizeRuntimeChoice(runtime);
    const parts = [];
    if (normalized.permissionMode) parts.push(app.permissionModeDisplayName(normalized.permissionMode));
    if (normalized.model) parts.push(app.modelDisplayName(normalized.model));
    if (normalized.reasoningEffort) parts.push(`推理 ${app.reasoningDisplayName(normalized.reasoningEffort)}`);
    return parts.join(" · ");
  };

  app.normalizePermissionMode = function normalizePermissionMode(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "readonly" || normalized === "read-only" || normalized === "suggest") return "strict";
    if (normalized === "approve" || normalized === "approved" || normalized === "auto" || normalized === "auto-edit") {
      return "approve";
    }
    if (normalized === "full" || normalized === "full-auto" || normalized === "fullaccess") return "full";
    return permissionOptions.some((option) => option.value === normalized) ? normalized : "";
  };

  app.permissionModeFromRuntime = function permissionModeFromRuntime(runtime = {}) {
    const sandbox = app.normalizeSandboxModeValue(runtime.sandbox);
    if (sandbox === "read-only") return "strict";
    if (sandbox === "danger-full-access") return "full";
    if (sandbox === "workspace-write") return "approve";
    return "";
  };

  app.permissionRuntimeForMode = function permissionRuntimeForMode(mode) {
    const normalized = app.normalizePermissionMode(mode);
    if (normalized === "strict") return { sandbox: "read-only", approvalPolicy: "on-request" };
    if (normalized === "full") return { sandbox: "danger-full-access", approvalPolicy: "never" };
    if (normalized === "approve") return { sandbox: "workspace-write", approvalPolicy: "on-request" };
    return { sandbox: "", approvalPolicy: "" };
  };

  app.normalizeSandboxModeValue = function normalizeSandboxModeValue(value) {
    const normalized = String(value || "").trim();
    if (normalized === "workspaceWrite") return "workspace-write";
    if (normalized === "dangerFullAccess") return "danger-full-access";
    if (normalized === "readOnly") return "read-only";
    return normalized;
  };

  app.normalizeApprovalPolicyValue = function normalizeApprovalPolicyValue(value) {
    return String(value || "").trim().toLowerCase();
  };

  app.permissionModeDisplayName = function permissionModeDisplayName(value) {
    const normalized = app.normalizePermissionMode(value);
    return permissionOptions.find((option) => option.value === normalized)?.label || normalized;
  };

  app.modelDisplayName = function modelDisplayName(value) {
    const normalized = String(value || "").trim();
    return modelOptions.find((option) => option.value === normalized)?.label || normalized;
  };

  app.modelRequiresNewerCodex = function modelRequiresNewerCodex(value) {
    const model = String(value || "").trim();
    if (!model) return false;
    if (state.codexUnsupportedModels.includes(model)) return true;
    const supportedModelIds = (state.codexSupportedModels || []).map((item) => item.id);
    return supportedModelIds.length > 0 && !supportedModelIds.includes(model);
  };

  app.permissionModeUnavailable = function permissionModeUnavailable(value) {
    const mode = app.normalizePermissionMode(value);
    return Boolean(mode && state.codexAllowedPermissionModes.length > 0 && !state.codexAllowedPermissionModes.includes(mode));
  };

  app.modelSupportsImages = function modelSupportsImages(value) {
    return true;
  };

  app.runtimeForAttachments = function runtimeForAttachments(runtime = {}, attachments = []) {
    return runtime;
  };

  app.reasoningDisplayName = function reasoningDisplayName(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return reasoningOptions.find((option) => option.value === normalized)?.label || normalized;
  };

  app.humanizeCodexError = function humanizeCodexError(error) {
    const text = String(error || "").trim();
    if (!text) return "";
    if (/requires a newer version of Codex|Please upgrade to the latest app or CLI/i.test(text)) {
      return `${text}\n\n处理方式：在桌面端设置里把 Codex 模型固定为当前 CLI 支持的模型，或升级 Codex CLI。`;
    }
    if (/ENOENT|No such file or directory/i.test(text)) {
      return `${text}\n\n处理方式：检查桌面端 Codex command，必要时填入 codex 的绝对路径。`;
    }
    return text;
  };

  app.isAuthError = function isAuthError(error) {
    return error.status === 401 || error.code === "SESSION_REQUIRED" || error.code === "PAIRING_REQUIRED";
  };

  app.authHeaders = function authHeaders() {
    return {
      ...app.sessionHeaders(),
      ...(state.token ? { "X-Echo-Token": state.token } : {})
    };
  };

  app.sessionHeaders = function sessionHeaders() {
    return state.authEnabled && state.sessionToken ? { Authorization: `Bearer ${state.sessionToken}` } : {};
  };

  app.ensureLoggedIn = function ensureLoggedIn() {
    if (app.isLoggedIn()) return true;
    app.updateAuthView("请先登录。");
    elements.loginUsername.focus({ preventScroll: true });
    return false;
  };

  app.ensurePaired = function ensurePaired() {
    if (!app.ensureLoggedIn()) return false;
    if (state.token) return true;
    app.updateAuthView("请先扫码配对。");
    app.showPairingPanel({ focus: true });
    return false;
  };

  app.apiGet = async function apiGet(path) {
    const response = await fetch(path, { headers: app.authHeaders() });
    return app.parseApiResponse(response);
  };

  app.apiPost = async function apiPost(path, body, options = {}) {
    const controller = options.timeoutMs ? new AbortController() : null;
    const timeout = controller
      ? window.setTimeout(() => {
          controller.abort();
        }, options.timeoutMs)
      : null;
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...app.authHeaders()
        },
        body: JSON.stringify(body),
        signal: controller?.signal
      });
      return app.parseApiResponse(response);
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("请求超时");
      }
      throw error;
    } finally {
      if (timeout) window.clearTimeout(timeout);
    }
  };

  app.parseApiResponse = async function parseApiResponse(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = data.code || "";
      throw error;
    }
    return data;
  };

  app.toast = function toast(message) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();

    const node = document.createElement("div");
    node.className = "toast";
    node.textContent = message;
    document.body.append(node);
    window.setTimeout(() => node.remove(), 2600);
  };

  app.escapeHtml = function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  };
}

function readStoredUser(localStorageRef) {
  try {
    return JSON.parse(localStorageRef.getItem("echoUser") || "null");
  } catch {
    return null;
  }
}

function readStoredRuntimePreferences(localStorageRef) {
  return {
    permissionMode: localStorageRef.getItem("echoCodexPermissionMode") || "",
    model: localStorageRef.getItem("echoCodexModel") || DEFAULT_CODEX_MODEL,
    reasoningEffort: localStorageRef.getItem("echoCodexReasoningEffort") || ""
  };
}

function queryElements(documentRef) {
  return {
    topbar: documentRef.querySelector(".topbar"),
    themeColorMeta: documentRef.querySelector("#themeColorMeta"),
    appleStatusBarMeta: documentRef.querySelector("#appleStatusBarMeta"),
    statusText: documentRef.querySelector("#statusText"),
    mobileStatusIndicator: documentRef.querySelector("#mobileStatusIndicator"),
    userBadge: documentRef.querySelector("#userBadge"),
    logoutButton: documentRef.querySelector("#logoutButton"),
    openPairingButton: documentRef.querySelector("#openPairingButton"),
    refreshStatus: documentRef.querySelector("#refreshStatus"),
    themeModeToggle: documentRef.querySelector("#themeModeToggle"),
    loginPanel: documentRef.querySelector("#loginPanel"),
    loginForm: documentRef.querySelector("#loginForm"),
    loginStatus: documentRef.querySelector("#loginStatus"),
    loginUsername: documentRef.querySelector("#loginUsername"),
    loginPassword: documentRef.querySelector("#loginPassword"),
    loginButton: documentRef.querySelector("#loginButton"),
    pairingPanel: documentRef.querySelector("#pairingPanel"),
    pairingStatus: documentRef.querySelector("#pairingStatus"),
    pairingVideo: documentRef.querySelector("#pairingVideo"),
    pairingInput: documentRef.querySelector("#pairingInput"),
    scanPairingButton: documentRef.querySelector("#scanPairingButton"),
    stopScanButton: documentRef.querySelector("#stopScanButton"),
    savePairingButton: documentRef.querySelector("#savePairingButton"),
    authenticated: Array.from(documentRef.querySelectorAll("[data-authenticated]")),
    codexView: documentRef.querySelector("#codexView"),
    codexStatusText: documentRef.querySelector("#codexStatusText"),
    codexQueueMeta: documentRef.querySelector("#codexQueueMeta"),
    activeSessionTitle: documentRef.querySelector("#activeSessionTitle"),
    activeSessionMeta: documentRef.querySelector("#activeSessionMeta"),
    stopCodexTurnButton: documentRef.querySelector("#stopCodexTurnButton"),
    composerStatusText: documentRef.querySelector("#composerStatusText"),
    composerActionsMeta: documentRef.querySelector("#composerActionsMeta"),
    contextUsageIndicator: documentRef.querySelector("#contextUsageIndicator"),
    compactContextButton: documentRef.querySelector("#compactContextButton"),
    composerPlanModeButton: documentRef.querySelector("#composerPlanModeButton"),
    quickDeployButton: documentRef.querySelector("#quickDeployButton"),
    refreshCodex: documentRef.querySelector("#refreshCodex"),
    toggleSessionsButton: documentRef.querySelector("#toggleSessionsButton"),
    sessionBackdrop: documentRef.querySelector("#sessionBackdrop"),
    codexScrollSurface: documentRef.querySelector("#codexJobDetail"),
    showActiveSessionsButton: documentRef.querySelector("#showActiveSessionsButton"),
    showArchivedSessionsButton: documentRef.querySelector("#showArchivedSessionsButton"),
    sidebarUserToggle: documentRef.querySelector("#sidebarUserToggle"),
    sidebarUserBody: documentRef.querySelector("#sidebarUserBody"),
    projectSwitcher: documentRef.querySelector("#projectSwitcher"),
    projectSwitcherButton: documentRef.querySelector("#projectSwitcherButton"),
    projectSwitcherPanel: documentRef.querySelector("#projectSwitcherPanel"),
    topbarProjectChip: documentRef.querySelector("#projectSwitcherButton"),
    sidebarUserMeta: documentRef.querySelector("#sidebarUserMeta"),
    codexProject: documentRef.querySelector("#codexProject"),
    codexPermissionMode: documentRef.querySelector("#codexPermissionMode"),
    codexModel: documentRef.querySelector("#codexModel"),
    codexReasoningEffort: documentRef.querySelector("#codexReasoningEffort"),
    composerProjectLabel: documentRef.querySelector("#composerProjectLabel"),
    composerAttachmentButton: documentRef.querySelector("#composerAttachmentButton"),
    composerAttachmentInput: documentRef.querySelector("#composerAttachmentInput"),
    composerAttachmentTray: documentRef.querySelector("#composerAttachmentTray"),
    projectSidebarCard: documentRef.querySelector("#projectSidebarCard"),
    newProjectButton: documentRef.querySelector("#newProjectButton"),
    projectCreateForm: documentRef.querySelector("#projectCreateForm"),
    projectCreateName: documentRef.querySelector("#projectCreateName"),
    projectCreateSubmit: documentRef.querySelector("#projectCreateSubmit"),
    projectPickerLabel: documentRef.querySelector("#projectPickerLabel"),
    projectPickerMeta: documentRef.querySelector("#projectPickerMeta"),
    projectSheetStatus: documentRef.querySelector("#projectSheetStatus"),
    projectSheetList: documentRef.querySelector("#projectSheetList"),
    codexPrompt: documentRef.querySelector("#codexPrompt"),
    composer: documentRef.querySelector(".composer"),
    newCodexSessionButton: documentRef.querySelector("#newCodexSessionButton"),
    sendCodexButton: documentRef.querySelector("#sendCodexButton"),
    codexJobs: documentRef.querySelector("#codexJobs"),
    codexJobDetail: documentRef.querySelector("#codexJobDetail"),
    codexRunSummary: documentRef.querySelector("#codexRunSummary"),
    codexApprovals: documentRef.querySelector("#codexApprovals"),
    runLog: documentRef.querySelector(".run-log"),
    codexLog: documentRef.querySelector("#codexLog")
  };
}
