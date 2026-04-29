const params = new URLSearchParams(window.location.search);
const tokenFromUrl = params.get("token");
if (tokenFromUrl) localStorage.setItem("echoToken", tokenFromUrl);
let token = tokenFromUrl || localStorage.getItem("echoToken") || "";
let sessionToken = localStorage.getItem("echoSession") || "";
let currentUser = readStoredUser();
let authEnabled = true;
const mobileRefineTimeoutMs = 10000;
const MAX_COMPOSER_ATTACHMENTS = 3;
const MAX_COMPOSER_ATTACHMENT_BYTES = 6 * 1024 * 1024;
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
if (tokenFromUrl) {
  window.history.replaceState({}, "", window.location.pathname);
}

const elements = {
  topbar: document.querySelector(".topbar"),
  statusText: document.querySelector("#statusText"),
  userBadge: document.querySelector("#userBadge"),
  logoutButton: document.querySelector("#logoutButton"),
  openPairingButton: document.querySelector("#openPairingButton"),
  refreshStatus: document.querySelector("#refreshStatus"),
  loginPanel: document.querySelector("#loginPanel"),
  loginForm: document.querySelector("#loginForm"),
  loginStatus: document.querySelector("#loginStatus"),
  loginUsername: document.querySelector("#loginUsername"),
  loginPassword: document.querySelector("#loginPassword"),
  loginButton: document.querySelector("#loginButton"),
  pairingPanel: document.querySelector("#pairingPanel"),
  pairingStatus: document.querySelector("#pairingStatus"),
  pairingVideo: document.querySelector("#pairingVideo"),
  pairingInput: document.querySelector("#pairingInput"),
  scanPairingButton: document.querySelector("#scanPairingButton"),
  stopScanButton: document.querySelector("#stopScanButton"),
  savePairingButton: document.querySelector("#savePairingButton"),
  authenticated: Array.from(document.querySelectorAll("[data-authenticated]")),
  codexView: document.querySelector("#codexView"),
  codexStatusText: document.querySelector("#codexStatusText"),
  codexQueueMeta: document.querySelector("#codexQueueMeta"),
  activeSessionTitle: document.querySelector("#activeSessionTitle"),
  activeSessionMeta: document.querySelector("#activeSessionMeta"),
  composerStatusText: document.querySelector("#composerStatusText"),
  composerActionsMeta: document.querySelector("#composerActionsMeta"),
  refreshCodex: document.querySelector("#refreshCodex"),
  toggleSessionsButton: document.querySelector("#toggleSessionsButton"),
  sessionBackdrop: document.querySelector("#sessionBackdrop"),
  codexScrollSurface: document.querySelector("#codexJobDetail"),
  sessionSearch: document.querySelector("#sessionSearch"),
  showActiveSessionsButton: document.querySelector("#showActiveSessionsButton"),
  showArchivedSessionsButton: document.querySelector("#showArchivedSessionsButton"),
  topbarProjectChip: document.querySelector(".topbar-project-chip"),
  sidebarUserMeta: document.querySelector("#sidebarUserMeta"),
  codexProject: document.querySelector("#codexProject"),
  codexPermissionMode: document.querySelector("#codexPermissionMode"),
  codexModel: document.querySelector("#codexModel"),
  codexReasoningEffort: document.querySelector("#codexReasoningEffort"),
  composerProjectLabel: document.querySelector("#composerProjectLabel"),
  composerAttachmentButton: document.querySelector("#composerAttachmentButton"),
  composerAttachmentInput: document.querySelector("#composerAttachmentInput"),
  composerAttachmentTray: document.querySelector("#composerAttachmentTray"),
  projectSidebarCard: document.querySelector("#projectSidebarCard"),
  projectPickerLabel: document.querySelector("#projectPickerLabel"),
  projectPickerMeta: document.querySelector("#projectPickerMeta"),
  projectSheetStatus: document.querySelector("#projectSheetStatus"),
  projectSheetList: document.querySelector("#projectSheetList"),
  codexPrompt: document.querySelector("#codexPrompt"),
  composer: document.querySelector(".composer"),
  postprocessToggle: document.querySelector("#postprocessToggle"),
  postprocessLabel: document.querySelector("#postprocessLabel"),
  newCodexSessionButton: document.querySelector("#newCodexSessionButton"),
  sendCodexButton: document.querySelector("#sendCodexButton"),
  codexJobs: document.querySelector("#codexJobs"),
  codexJobDetail: document.querySelector("#codexJobDetail"),
  codexRunSummary: document.querySelector("#codexRunSummary"),
  codexApprovals: document.querySelector("#codexApprovals"),
  runLog: document.querySelector(".run-log"),
  codexLog: document.querySelector("#codexLog")
};

let codexTimer = null;
let pairingStream = null;
let pairingScanActive = false;
let pairingScanBusy = false;
let selectedCodexJobId = "";
let selectedCodexSession = null;
let composingNewSession = false;
let codexWorkspaces = [];
let showArchivedSessions = false;
let sessionSearchQuery = "";
let postprocessEnabled = localStorage.getItem("echoPostprocessEnabled") !== "false";
let composerBusy = false;
let codexAgentRuntime = {};
let runtimePreferences = readStoredRuntimePreferences();
let runtimeDirty = false;
let lastTopbarScrollY = 0;
let topbarScrollAccumulator = 0;
let topbarCollapsed = false;
let composerAttachments = [];

bindViewportMetrics();
bindTopbarScrollState();
initRuntimeControls();
elements.loginForm.addEventListener("submit", login);
elements.logoutButton.addEventListener("click", logout);
elements.openPairingButton.addEventListener("click", () => showPairingPanel({ focus: true }));
elements.refreshStatus.addEventListener("click", refreshStatus);
elements.scanPairingButton.addEventListener("click", startPairingScanner);
elements.stopScanButton.addEventListener("click", stopPairingScanner);
elements.savePairingButton.addEventListener("click", pairFromInput);
elements.refreshCodex?.addEventListener("click", refreshCodex);
elements.newCodexSessionButton.addEventListener("click", startNewCodexSession);
elements.sendCodexButton.addEventListener("click", sendToCodex);
elements.toggleSessionsButton.addEventListener("click", toggleSessionSidebar);
elements.sessionBackdrop.addEventListener("click", closeSessionSidebar);
elements.sessionSearch.addEventListener("input", () => {
  sessionSearchQuery = elements.sessionSearch.value.trim().toLowerCase();
  loadCodexJobs().catch(() => {});
});
elements.showActiveSessionsButton.addEventListener("click", () => setSessionArchiveView(false));
elements.showArchivedSessionsButton.addEventListener("click", () => setSessionArchiveView(true));
elements.codexProject.addEventListener("change", () => {
  localStorage.setItem("echoCodexProject", elements.codexProject.value);
  syncProjectPicker();
  refreshActiveSessionHeader();
  updateComposerAvailability();
});
elements.codexPermissionMode.addEventListener("change", handleRuntimeControlChange);
elements.codexModel.addEventListener("change", handleRuntimeControlChange);
elements.codexReasoningEffort.addEventListener("change", handleRuntimeControlChange);
elements.codexPrompt.addEventListener("input", updateComposerAvailability);
elements.composerAttachmentButton.addEventListener("click", openComposerAttachmentPicker);
elements.composerAttachmentInput.addEventListener("change", handleComposerAttachmentInput);
elements.codexPrompt.addEventListener("paste", handleComposerPaste);
document.addEventListener("keydown", handleGlobalKeydown);
elements.postprocessToggle.addEventListener("change", () => {
  postprocessEnabled = elements.postprocessToggle.checked;
  localStorage.setItem("echoPostprocessEnabled", postprocessEnabled ? "true" : "false");
  updatePostprocessUi();
  toast(postprocessEnabled ? "后处理已开启" : "后处理已关闭");
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

updatePostprocessUi();
renderComposerAttachments();
updateSessionSidebarToggle(false);
await bootUserSession();
updateAuthView();
if (isLoggedIn() && token) {
  await bootAuthenticated();
}

async function bootUserSession() {
  await loadAuthConfig();
  if (!authEnabled) {
    sessionToken = "";
    currentUser = { username: "local", displayName: "Local", role: "owner" };
    localStorage.removeItem("echoSession");
    localStorage.removeItem("echoUser");
    return;
  }
  if (sessionToken) {
    await refreshCurrentUser({ silent: true });
  }
}

async function bootAuthenticated() {
  if (!isLoggedIn()) {
    updateAuthView();
    return;
  }
  updateAuthView();
  await refreshStatus({ silentAuthFailure: true });
  if (!token) return;
  await refreshCodex();
  if (!codexTimer) codexTimer = window.setInterval(refreshCodex, 3500);
}

function updateAuthView(message = "") {
  const loggedIn = isLoggedIn();
  const paired = Boolean(token);
  const showApp = loggedIn && paired;

  if (!showApp) {
    resetTopbarScrollTracking({ forceVisible: true });
  }

  if (!showApp && elements.codexView.classList.contains("sessions-open")) {
    closeSessionSidebar({ restoreFocus: false });
  }

  elements.loginPanel.hidden = loggedIn;
  elements.pairingPanel.hidden = !loggedIn || paired;
  elements.openPairingButton.hidden = !loggedIn;
  elements.openPairingButton.textContent = paired ? "重新配对" : "扫码配对";
  elements.refreshStatus.hidden = !showApp;
  elements.userBadge.hidden = !loggedIn;
  elements.logoutButton.hidden = !authEnabled || !loggedIn;
  elements.userBadge.textContent = loggedIn ? displayUser(currentUser) : "";
  renderUserCenter();
  for (const node of elements.authenticated) node.hidden = !showApp;
  refreshTopbarProjectChip();

  if (!loggedIn) {
    elements.statusText.textContent = "等待登录";
    elements.loginStatus.textContent = message || "请输入账号后继续。";
    return;
  }

  if (!paired) {
    elements.statusText.textContent = "等待配对";
    elements.pairingStatus.textContent = message || "如果你是直接打开这个网页，请先扫桌面端显示的二维码。";
    return;
  }

  if (message) elements.statusText.textContent = message;
}

async function loadAuthConfig() {
  try {
    const response = await fetch("/api/auth/config");
    const data = await parseApiResponse(response);
    authEnabled = Boolean(data.enabled);
  } catch {
    authEnabled = true;
  }
}

async function refreshCurrentUser({ silent = false } = {}) {
  try {
    const response = await fetch("/api/auth/me", { headers: sessionHeaders() });
    const data = await parseApiResponse(response);
    setCurrentUser(data.user);
  } catch {
    enterLogin(silent ? "" : "登录已过期，请重新登录。");
  }
}

async function login(event) {
  event.preventDefault();
  elements.loginButton.disabled = true;
  elements.loginStatus.textContent = "登录中...";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username: elements.loginUsername.value.trim(),
        password: elements.loginPassword.value
      })
    });
    const data = await parseApiResponse(response);
    sessionToken = data.sessionToken || "";
    localStorage.setItem("echoSession", sessionToken);
    setCurrentUser(data.user);
    elements.loginPassword.value = "";
    toast("已登录");
    if (token) {
      await bootAuthenticated();
    } else {
      updateAuthView();
    }
  } catch (error) {
    elements.loginStatus.textContent = error.message || "登录失败";
  } finally {
    elements.loginButton.disabled = false;
  }
}

function logout() {
  sessionToken = "";
  currentUser = null;
  localStorage.removeItem("echoSession");
  localStorage.removeItem("echoUser");
  if (codexTimer) {
    window.clearInterval(codexTimer);
    codexTimer = null;
  }
  stopPairingScanner();
  closeSessionSidebar({ restoreFocus: false });
  updateAuthView("已退出，请重新登录。");
}

function enterLogin(message = "登录已过期，请重新登录。") {
  sessionToken = "";
  currentUser = null;
  localStorage.removeItem("echoSession");
  localStorage.removeItem("echoUser");
  if (codexTimer) {
    window.clearInterval(codexTimer);
    codexTimer = null;
  }
  stopPairingScanner();
  closeSessionSidebar({ restoreFocus: false });
  updateAuthView(message);
}

function renderUserCenter() {
  const loggedIn = isLoggedIn();
  if (!loggedIn) {
    elements.sidebarUserMeta.textContent = "请先登录，然后连接桌面端。";
    return;
  }
  elements.sidebarUserMeta.textContent = token
    ? "已连接桌面端，可以在这里刷新状态、重新配对或退出。"
    : "账号已登录，但还没有连接桌面端。";
}

function setCurrentUser(user, options = {}) {
  currentUser = user || null;
  if (currentUser) {
    localStorage.setItem("echoUser", JSON.stringify(currentUser));
  } else {
    localStorage.removeItem("echoUser");
  }
  if (options.updateView !== false) updateAuthView();
}

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem("echoUser") || "null");
  } catch {
    return null;
  }
}

function isLoggedIn() {
  return !authEnabled || Boolean(sessionToken && currentUser);
}

function displayUser(user) {
  return user?.displayName || user?.username || "";
}

function bindViewportMetrics() {
  syncViewportMetrics();
  window.addEventListener("resize", syncViewportMetrics, { passive: true });
  window.visualViewport?.addEventListener("resize", syncViewportMetrics, { passive: true });
  window.visualViewport?.addEventListener("scroll", syncViewportMetrics, { passive: true });
}

function syncViewportMetrics() {
  const viewport = window.visualViewport;
  const nextHeight = Math.round(viewport?.height || window.innerHeight || 0);
  if (nextHeight > 0) document.documentElement.style.setProperty("--app-height", `${nextHeight}px`);
  if (elements.topbar) {
    document.documentElement.style.setProperty("--topbar-height", `${Math.round(elements.topbar.offsetHeight || 0)}px`);
  }
  syncComposerMetrics();
}

function bindTopbarScrollState() {
  resetTopbarScrollTracking({ forceVisible: true });
  elements.codexScrollSurface?.addEventListener(
    "scroll",
    () => {
      syncTopbarVisibility();
    },
    { passive: true }
  );
  window.addEventListener(
    "resize",
    () => {
      resetTopbarScrollTracking({ forceVisible: true });
    },
    { passive: true }
  );
}

function resetTopbarScrollTracking(options = {}) {
  lastTopbarScrollY = currentTopbarScrollY();
  topbarScrollAccumulator = 0;
  if (options.forceVisible) {
    setTopbarCollapsed(false);
  }
}

function syncTopbarVisibility(options = {}) {
  if (!usesCompactTopbarMode()) {
    resetTopbarScrollTracking({ forceVisible: true });
    return;
  }

  const currentY = currentTopbarScrollY();
  const lastY = lastTopbarScrollY;
  const delta = currentY - lastY;
  lastTopbarScrollY = currentY;
  if (options.forceVisible || currentY <= 8 || elements.codexView.classList.contains("sessions-open")) {
    topbarScrollAccumulator = 0;
    setTopbarCollapsed(false);
    return;
  }
  if (Math.abs(delta) < 1) return;
  if (topbarScrollAccumulator && Math.sign(topbarScrollAccumulator) !== Math.sign(delta)) {
    topbarScrollAccumulator = delta;
  } else {
    topbarScrollAccumulator += delta;
  }
  if (topbarScrollAccumulator >= 18) {
    topbarScrollAccumulator = 0;
    setTopbarCollapsed(true);
  } else if (topbarScrollAccumulator <= -10) {
    topbarScrollAccumulator = 0;
    setTopbarCollapsed(false);
  }
}

function currentTopbarScrollY() {
  if (usesCompactTopbarMode()) {
    return Math.max(elements.codexScrollSurface?.scrollTop || 0, 0);
  }
  return Math.max(window.scrollY || 0, 0);
}

function usesCompactTopbarMode() {
  return window.matchMedia("(max-width: 760px)").matches && !elements.codexView.hidden;
}

function setTopbarCollapsed(collapsed) {
  if (topbarCollapsed === collapsed) return;
  topbarCollapsed = collapsed;
  document.body.classList.toggle("topbar-collapsed", collapsed);
}

function syncComposerMetrics() {
  const composerHeight = Math.round(elements.composer?.offsetHeight || 0);
  if (composerHeight > 0) {
    document.documentElement.style.setProperty("--composer-height", `${composerHeight}px`);
  }
}

function refreshComposerStatusBar() {
  if (!elements.composerStatusText) return;

  const session = composingNewSession ? null : selectedCodexSession;
  if (composerBusy) {
    elements.composerStatusText.textContent = "正在发送…";
    return;
  }
  if (!elements.codexProject.value) {
    elements.composerStatusText.textContent = "先选择工程";
    return;
  }
  if (session?.pendingApprovalCount > 0) {
    elements.composerStatusText.textContent = "等待你的审批";
    return;
  }
  if (session?.status === "starting") {
    elements.composerStatusText.textContent = "Codex 正在启动";
    return;
  }
  if (session?.status === "running") {
    elements.composerStatusText.textContent = "Codex 正在回复";
    return;
  }
  if (session?.pendingCommandCount > 0) {
    elements.composerStatusText.textContent = "消息已排队";
    return;
  }
  if (session && !sessionCanAcceptFollowUp(session)) {
    elements.composerStatusText.textContent = "当前会话不可继续";
    return;
  }
  elements.composerStatusText.textContent = "工作区";
}

function initRuntimeControls() {
  populateRuntimeSelect(elements.codexPermissionMode, PERMISSION_MODE_OPTIONS);
  populateRuntimeSelect(elements.codexModel, MODEL_OPTIONS);
  populateRuntimeSelect(elements.codexReasoningEffort, REASONING_OPTIONS);
  applyRuntimeDraft(runtimePreferences, { persist: false, dirty: false });
  refreshRuntimeDefaultOptions();
}

function populateRuntimeSelect(select, options) {
  select.innerHTML = "";
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.append(node);
  }
}

function handleRuntimeControlChange() {
  runtimeDirty = true;
  runtimePreferences = currentRuntimeDraft();
  writeStoredRuntimePreferences(runtimePreferences);
  refreshActiveSessionHeader();
  refreshComposerMeta();
}

function currentRuntimeDraft() {
  const next = normalizeRuntimeChoice({
    permissionMode: elements.codexPermissionMode.value,
    model: elements.codexModel.value,
    reasoningEffort: elements.codexReasoningEffort.value
  });
  const preset = permissionRuntimeForMode(next.permissionMode);
  return {
    ...next,
    profile: next.permissionMode || "",
    sandbox: next.permissionMode ? preset.sandbox : "",
    approvalPolicy: next.permissionMode ? preset.approvalPolicy : ""
  };
}

function applyRuntimeDraft(runtime = {}, options = {}) {
  const next = normalizeRuntimeChoice(runtime);
  ensureRuntimeOption(
    elements.codexPermissionMode,
    PERMISSION_MODE_OPTIONS,
    next.permissionMode,
    permissionModeDisplayName(next.permissionMode)
  );
  ensureRuntimeOption(elements.codexModel, MODEL_OPTIONS, next.model, modelDisplayName(next.model));
  ensureRuntimeOption(
    elements.codexReasoningEffort,
    REASONING_OPTIONS,
    next.reasoningEffort,
    reasoningDisplayName(next.reasoningEffort)
  );
  elements.codexPermissionMode.value = next.permissionMode;
  elements.codexModel.value = next.model;
  elements.codexReasoningEffort.value = next.reasoningEffort;
  runtimeDirty = Boolean(options.dirty);
  if (options.persist !== false) {
    runtimePreferences = next;
    writeStoredRuntimePreferences(next);
  }
  refreshRuntimeDefaultOptions();
}

function refreshRuntimeDefaultOptions() {
  const permissionOption = elements.codexPermissionMode.querySelector('option[value=""]');
  const modelOption = elements.codexModel.querySelector('option[value=""]');
  const reasoningOption = elements.codexReasoningEffort.querySelector('option[value=""]');
  if (permissionOption) {
    permissionOption.textContent = codexAgentRuntime.permissionMode
      ? `默认 · ${permissionModeDisplayName(codexAgentRuntime.permissionMode)}`
      : "默认";
  }
  if (modelOption) {
    modelOption.textContent = codexAgentRuntime.model ? `默认 · ${modelDisplayName(codexAgentRuntime.model)}` : "默认";
  }
  if (reasoningOption) {
    reasoningOption.textContent = codexAgentRuntime.reasoningEffort
      ? `默认 · ${reasoningDisplayName(codexAgentRuntime.reasoningEffort)}`
      : "默认";
  }
}

function ensureRuntimeOption(select, options, value, fallbackLabel) {
  if (!value) return;
  const known = options.some((option) => option.value === value);
  const existing = Array.from(select.options).find((option) => option.value === value);
  if (known || existing) return;
  const node = document.createElement("option");
  node.value = value;
  node.textContent = fallbackLabel || value;
  select.append(node);
}

function normalizeRuntimeChoice(runtime = {}) {
  const knownModelValues = new Set(MODEL_OPTIONS.map((option) => option.value));
  const knownReasoningValues = new Set(REASONING_OPTIONS.map((option) => option.value));
  const permissionMode = normalizePermissionMode(
    runtime.permissionMode || runtime.permissionsMode || runtime.profile || permissionModeFromRuntime(runtime)
  );
  const model = String(runtime.model || "").trim();
  const reasoningEffort = String(runtime.reasoningEffort || runtime.effort || "").trim().toLowerCase();
  return {
    permissionMode,
    sandbox: normalizeSandboxModeValue(runtime.sandbox),
    approvalPolicy: normalizeApprovalPolicyValue(runtime.approvalPolicy),
    model: knownModelValues.has(model) || model ? model : "",
    reasoningEffort: knownReasoningValues.has(reasoningEffort) || reasoningEffort ? reasoningEffort : ""
  };
}

function readStoredRuntimePreferences() {
  return normalizeRuntimeChoice({
    permissionMode: localStorage.getItem("echoCodexPermissionMode") || "",
    model: localStorage.getItem("echoCodexModel") || "",
    reasoningEffort: localStorage.getItem("echoCodexReasoningEffort") || ""
  });
}

function writeStoredRuntimePreferences(runtime = {}) {
  const next = normalizeRuntimeChoice(runtime);
  if (next.permissionMode) localStorage.setItem("echoCodexPermissionMode", next.permissionMode);
  else localStorage.removeItem("echoCodexPermissionMode");
  if (next.model) localStorage.setItem("echoCodexModel", next.model);
  else localStorage.removeItem("echoCodexModel");
  if (next.reasoningEffort) localStorage.setItem("echoCodexReasoningEffort", next.reasoningEffort);
  else localStorage.removeItem("echoCodexReasoningEffort");
}

function showPairingPanel({ focus = false } = {}) {
  if (!ensureLoggedIn()) return;
  updateAuthView();
  elements.pairingPanel.hidden = false;
  if (token && !elements.pairingStatus.textContent.trim()) {
    elements.pairingStatus.textContent = "重新扫码会覆盖当前桌面端配对。";
  }
  if (focus) {
    elements.pairingPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    elements.scanPairingButton.focus({ preventScroll: true });
  }
}

function enterPairing(message = "配对已失效，请重新扫描桌面端二维码。") {
  localStorage.removeItem("echoToken");
  token = "";
  if (codexTimer) {
    window.clearInterval(codexTimer);
    codexTimer = null;
  }
  stopPairingScanner();
  updateAuthView(message);
}

function handleAuthError(error, message) {
  if (error.code === "SESSION_REQUIRED") {
    enterLogin("登录已过期，请重新登录。");
    return true;
  }
  if (error.code && error.code !== "PAIRING_REQUIRED") return false;
  if (error.status !== 401) return false;
  enterPairing(message);
  return true;
}

async function refreshStatus(options = {}) {
  if (!isLoggedIn()) {
    updateAuthView();
    return;
  }
  if (!token) {
    updateAuthView();
    return;
  }

  try {
    const status = await apiGet("/api/status");
    const codexOnline = status.codex?.agentOnline;
    elements.statusText.textContent = codexOnline ? "Codex 在线" : status.mode === "relay" ? "等待桌面 agent" : status.platform;
    if (status.user) setCurrentUser(status.user, { updateView: false });
    renderUserCenter();
    if (status.codex) renderCodexStatus(status.codex);
  } catch (error) {
    if (handleAuthError(error, "当前浏览器没有有效配对，请扫描桌面端二维码。")) {
      if (!options.silentAuthFailure) {
        elements.pairingStatus.textContent = "当前浏览器没有有效配对，请扫描桌面端二维码。";
      }
    } else {
      elements.statusText.textContent = "连接失败";
      toast(error.message);
    }
  }
}

async function startPairingScanner() {
  if (!ensureLoggedIn()) return;
  showPairingPanel();
  if (!window.isSecureContext) {
    toast("扫码需要 HTTPS 或 localhost 安全上下文");
    return;
  }
  if (!("BarcodeDetector" in window)) {
    elements.pairingStatus.textContent = "当前浏览器不支持网页扫码，请使用 Android Chrome，或粘贴桌面端配对链接。";
    return;
  }

  try {
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    pairingStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment"
      }
    });
    elements.pairingVideo.srcObject = pairingStream;
    await elements.pairingVideo.play();
    pairingScanActive = true;
    elements.pairingStatus.textContent = "正在扫描桌面端二维码...";
    elements.scanPairingButton.hidden = true;
    elements.stopScanButton.hidden = false;
    scanPairingFrame(detector);
  } catch (error) {
    stopPairingScanner();
    elements.pairingStatus.textContent = "相机没有启动，请检查浏览器相机权限，或粘贴配对链接。";
    toast(error.message);
  }
}

async function scanPairingFrame(detector) {
  if (!pairingScanActive) return;
  if (!pairingScanBusy && elements.pairingVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    pairingScanBusy = true;
    try {
      const codes = await detector.detect(elements.pairingVideo);
      const value = codes[0]?.rawValue || "";
      const nextToken = extractPairingToken(value);
      if (nextToken) {
        await completePairing(nextToken);
        return;
      }
    } catch {
      // Keep scanning; transient detector errors are common while the camera warms up.
    } finally {
      pairingScanBusy = false;
    }
  }
  requestAnimationFrame(() => scanPairingFrame(detector));
}

function stopPairingScanner() {
  pairingScanActive = false;
  pairingScanBusy = false;
  if (pairingStream) {
    pairingStream.getTracks().forEach((track) => track.stop());
    pairingStream = null;
  }
  elements.pairingVideo.srcObject = null;
  elements.scanPairingButton.hidden = false;
  elements.stopScanButton.hidden = true;
  if (!token) elements.pairingStatus.textContent ||= "如果你是直接打开这个网页，请先扫桌面端显示的二维码。";
}

async function pairFromInput() {
  const nextToken = extractPairingToken(elements.pairingInput.value);
  if (!nextToken) {
    elements.pairingStatus.textContent = "没有找到配对 token，请粘贴完整配对链接或 token。";
    return;
  }
  await completePairing(nextToken);
}

function extractPairingToken(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, window.location.origin);
    const urlToken = url.searchParams.get("token") || "";
    if (urlToken) return urlToken;
  } catch {
    // Fall through to raw-token handling.
  }
  return /^[A-Za-z0-9._-]{12,}$/.test(text) ? text : "";
}

async function completePairing(nextToken) {
  if (!ensureLoggedIn()) return;
  token = nextToken;
  localStorage.setItem("echoToken", token);
  stopPairingScanner();
  elements.pairingInput.value = "";
  await bootAuthenticated();
  if (token) toast("配对成功");
}

async function refreshCodex() {
  if (!isLoggedIn() || !token) return;

  try {
    const data = await apiGet("/api/codex/status");
    renderCodexStatus(data);
    await loadCodexJobs();
  } catch (error) {
    if (handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) return;
    elements.codexStatusText.textContent = "Codex 未连接";
    elements.codexQueueMeta.textContent = "";
    codexWorkspaces = [];
    codexAgentRuntime = {};
    refreshRuntimeDefaultOptions();
    elements.codexProject.innerHTML = "";
    renderProjectPicker(false);
    updateComposerAvailability();
    if (error.message && !error.message.includes("relay mode")) toast(error.message);
  }
}

function renderCodexStatus(codex) {
  const workspaces = codex.workspaces || [];
  codexWorkspaces = workspaces;
  codexAgentRuntime = normalizeRuntimeChoice(codex.runtime || {});
  refreshRuntimeDefaultOptions();
  elements.codexStatusText.textContent = codex.agentOnline ? "本机 Codex 在线" : "等待桌面 agent";
  elements.codexQueueMeta.textContent = codex.agentOnline
    ? `会话 ${codex.interactive?.activeSessions || 0} · 待审批 ${codex.interactive?.pendingApprovals || 0} · 归档 ${codex.interactive?.archivedSessions || 0} · 项目 ${workspaces.length}`
    : "打开桌面端后自动同步";

  const preferred = localStorage.getItem("echoCodexProject") || elements.codexProject.value;
  const selected = workspaces.find((workspace) => workspace.id === preferred)?.id || workspaces[0]?.id || "";
  elements.codexProject.innerHTML = "";
  if (!workspaces.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = codex.agentOnline ? "还没有授权工程目录" : "等待桌面 agent";
    elements.codexProject.append(option);
  }
  for (const workspace of workspaces) {
    const option = document.createElement("option");
    option.value = workspace.id;
    option.textContent = workspace.label || workspace.id || workspace.path;
    option.title = workspace.path || "";
    option.selected = workspace.id === selected;
    elements.codexProject.append(option);
  }
  if (elements.codexProject.value) {
    localStorage.setItem("echoCodexProject", elements.codexProject.value);
  }
  renderProjectPicker(codex.agentOnline);
  updateComposerAvailability();
  syncComposerMetrics();
}

function openSessionSidebar() {
  elements.codexView.classList.add("sessions-open");
  setTopbarCollapsed(false);
  elements.sessionBackdrop.hidden = false;
  updateSessionSidebarToggle(true);
  syncBodySheetState();
  window.requestAnimationFrame(() => {
    elements.sessionSearch.focus({ preventScroll: true });
  });
}

function closeSessionSidebar({ restoreFocus = true } = {}) {
  elements.codexView.classList.remove("sessions-open");
  elements.sessionBackdrop.hidden = true;
  updateSessionSidebarToggle(false);
  syncBodySheetState();
  resetTopbarScrollTracking({ forceVisible: true });
  if (restoreFocus) {
    elements.toggleSessionsButton.focus({ preventScroll: true });
  }
}

function toggleSessionSidebar() {
  if (elements.codexView.classList.contains("sessions-open")) {
    closeSessionSidebar();
    return;
  }
  openSessionSidebar();
}

function updateSessionSidebarToggle(isOpen) {
  const label = isOpen ? "关闭会话列表" : "打开会话列表";
  elements.toggleSessionsButton.textContent = isOpen ? "✕" : "☰";
  elements.toggleSessionsButton.setAttribute("aria-label", label);
  elements.toggleSessionsButton.setAttribute("title", label);
  elements.toggleSessionsButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
}

function syncBodySheetState() {
  document.body.classList.toggle("sheet-open", elements.codexView.classList.contains("sessions-open"));
}

async function setSessionArchiveView(archived) {
  if (showArchivedSessions === archived) return;
  showArchivedSessions = archived;
  elements.showActiveSessionsButton.classList.toggle("active", !archived);
  elements.showArchivedSessionsButton.classList.toggle("active", archived);
  composingNewSession = false;
  selectedCodexJobId = "";
  selectedCodexSession = null;
  applyRuntimeDraft(runtimePreferences, { persist: false, dirty: false });
  renderEmptySessionDetail(
    archived
      ? { title: "归档", body: "归档会话只保留查看和恢复。" }
      : { title: "新会话", body: "选择权限、模型和推理强度后直接发送。" }
  );
  await loadCodexJobs();
}

function startNewCodexSession() {
  selectedCodexJobId = "";
  selectedCodexSession = null;
  composingNewSession = true;
  clearComposerAttachments({ silent: true });
  applyRuntimeDraft(runtimePreferences, { persist: false, dirty: false });
  if (showArchivedSessions) {
    showArchivedSessions = false;
    elements.showActiveSessionsButton.classList.add("active");
    elements.showArchivedSessionsButton.classList.remove("active");
    loadCodexJobs().catch(() => {});
  }
  closeSessionSidebar({ restoreFocus: false });
  renderEmptySessionDetail({
    title: "新会话",
    body: "选择权限、模型和推理强度后直接发送。"
  });
  resetTopbarScrollTracking({ forceVisible: true });
  for (const button of elements.codexJobs.querySelectorAll(".conversation-item")) {
    button.classList.remove("active");
  }
  updateComposerAvailability();
  elements.codexPrompt.focus({ preventScroll: true });
}

async function sendToCodex() {
  if (!ensurePaired()) return;

  const rawPrompt = elements.codexPrompt.value.trim();
  const attachments = currentComposerAttachmentsPayload();
  const attachmentCount = attachments.length;
  const projectId = elements.codexProject.value;
  const runtime = currentRuntimeDraft();
  if (!rawPrompt && attachments.length === 0) {
    toast("请先填写任务或附上截图");
    return;
  }
  if (!projectId) {
    toast("桌面 agent 还没有公布项目");
    return;
  }

  localStorage.setItem("echoCodexProject", projectId);
  setComposerBusy(true, postprocessEnabled ? "整理中" : "发送中");
  try {
    const prompt = rawPrompt && postprocessEnabled ? await refinePromptForCodex(rawPrompt) : rawPrompt;
    setComposerBusy(true, "发送中");
    const data = await sendCodexPrompt({ projectId, prompt, runtime, attachments });
    if (showArchivedSessions) {
      showArchivedSessions = false;
      elements.showActiveSessionsButton.classList.add("active");
      elements.showArchivedSessionsButton.classList.remove("active");
    }
    selectedCodexJobId = data.session.id;
    selectedCodexSession = data.session;
    composingNewSession = false;
    runtimeDirty = false;
    applyRuntimeDraft(selectedCodexSession.runtime || runtime, { persist: false, dirty: false });
    elements.codexPrompt.value = "";
    await loadCodexJobs();
    await showCodexJob(data.session.id);
    clearComposerAttachments({ silent: true });
    toast(attachmentCount > 0 ? `已发送 ${attachmentCount} 个附件` : "已发送");
    await refreshStatus({ silentAuthFailure: true });
  } catch (error) {
    if (!handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
      toast(error.message);
    }
  } finally {
    setComposerBusy(false);
  }
}

async function sendCodexPrompt({ projectId, prompt, runtime, attachments }) {
  if (canContinueSelectedSession()) {
    return apiPost(`/api/codex/sessions/${encodeURIComponent(selectedCodexJobId)}/messages`, {
      text: prompt,
      runtime,
      attachments
    });
  }
  if (!canStartNewSessionFromComposer()) {
    throw new Error("当前会话不能继续，请先从左上角新建会话。");
  }
  return apiPost("/api/codex/sessions", { projectId, prompt, runtime, attachments });
}

function canContinueSelectedSession() {
  return sessionCanAcceptFollowUp(selectedSessionForComposer());
}

function selectedSessionForComposer() {
  if (composingNewSession) return null;
  if (!selectedCodexJobId || !selectedCodexSession) return null;
  return selectedCodexSession;
}

function sessionCanAcceptFollowUp(session) {
  if (!session || session.archivedAt) return false;
  return !["closed", "failed", "stale"].includes(session.status);
}

function canStartNewSessionFromComposer() {
  if (composingNewSession) return true;
  return !selectedCodexJobId && !selectedCodexSession;
}

function selectedSessionNeedsExplicitNew() {
  if (composingNewSession) return false;
  if (!selectedCodexJobId || !selectedCodexSession) return false;
  return !canContinueSelectedSession();
}

function sessionHasPendingWork(session) {
  if (!session) return false;
  return ["queued", "starting", "running"].includes(session.status) || Number(session.pendingCommandCount || 0) > 0;
}

function composerActionLabel() {
  if (selectedSessionNeedsExplicitNew()) return "先新建";
  if (!canContinueSelectedSession()) return "发送";
  return sessionHasPendingWork(selectedCodexSession) ? "继续排队" : "继续";
}

async function refinePromptForCodex(rawText) {
  try {
    const data = await apiPost(
      "/api/refine",
      {
        rawText,
        mode: "chat",
        contextHint: "手机端 Codex 任务输入",
        includeHistory: false
      },
      { timeoutMs: mobileRefineTimeoutMs }
    );
    const refined = String(data.item?.refined || data.item?.raw || rawText).trim();
    if (refined) elements.codexPrompt.value = refined;
    return refined || rawText;
  } catch (error) {
    if (isAuthError(error)) throw error;
    toast("后处理失败，已发送原文");
    return rawText;
  }
}

function openComposerAttachmentPicker() {
  if (composerBusy) return;
  elements.composerAttachmentInput.click();
}

async function handleComposerAttachmentInput(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  await addComposerAttachmentFiles(files);
}

async function handleComposerPaste(event) {
  const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
  if (files.length === 0) return;
  event.preventDefault();
  await addComposerAttachmentFiles(files);
}

async function addComposerAttachmentFiles(files = []) {
  const imageFiles = files.filter((file) => file && file.type.startsWith("image/"));
  if (imageFiles.length === 0) {
    if (files.length) toast("只能附加图片");
    return;
  }

  const remaining = MAX_COMPOSER_ATTACHMENTS - composerAttachments.length;
  if (remaining <= 0) {
    toast(`最多附加 ${MAX_COMPOSER_ATTACHMENTS} 张截图`);
    return;
  }

  const accepted = [];
  for (const file of imageFiles.slice(0, remaining)) {
    if (file.size > MAX_COMPOSER_ATTACHMENT_BYTES) {
      toast(`截图不能超过 ${Math.round(MAX_COMPOSER_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
      continue;
    }
    try {
      const url = await fileToDataUrl(file);
      accepted.push({
        id: crypto.randomUUID(),
        name: file.name || "截图",
        mimeType: file.type || "image/png",
        sizeBytes: file.size || 0,
        url
      });
    } catch {
      toast("读取截图失败，请重试");
    }
  }

  if (accepted.length === 0) return;
  composerAttachments = [...composerAttachments, ...accepted].slice(0, MAX_COMPOSER_ATTACHMENTS);
  renderComposerAttachments();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

function renderComposerAttachments() {
  const hasAttachments = composerAttachments.length > 0;
  elements.composerAttachmentTray.hidden = !hasAttachments;
  elements.composerAttachmentButton.classList.toggle("active", hasAttachments);
  elements.composerAttachmentButton.setAttribute(
    "aria-label",
    hasAttachments ? `已附加 ${composerAttachments.length} 张截图` : "附加截图"
  );
  elements.composerAttachmentTray.innerHTML = hasAttachments
    ? `
        ${composerAttachments
          .map((attachment, index) => {
            const label = attachmentDisplayLabel(attachment, index);
            return `
              <div class="composer-attachment-pill" data-attachment-id="${escapeHtml(attachment.id)}">
                <span class="composer-attachment-pill-label">${escapeHtml(label)}</span>
                <button type="button" class="composer-attachment-remove" aria-label="移除 ${escapeHtml(label)}">移除</button>
              </div>
            `;
          })
          .join("")}
      `
    : "";

  for (const button of elements.composerAttachmentTray.querySelectorAll(".composer-attachment-remove")) {
    button.addEventListener("click", () => {
      const chip = button.closest("[data-attachment-id]");
      if (!chip) return;
      removeComposerAttachment(chip.dataset.attachmentId || "");
    });
  }

  updateComposerAvailability();
}

function removeComposerAttachment(id) {
  composerAttachments = composerAttachments.filter((attachment) => attachment.id !== id);
  renderComposerAttachments();
}

function clearComposerAttachments(options = {}) {
  if (composerAttachments.length === 0 && options.silent) return;
  composerAttachments = [];
  renderComposerAttachments();
}

function currentComposerAttachmentsPayload() {
  return composerAttachments.map((attachment) => ({
    type: "image",
    url: attachment.url,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes
  }));
}

function setComposerBusy(isBusy, label = "") {
  composerBusy = isBusy;
  if (label) elements.statusText.textContent = label;
  elements.sendCodexButton.textContent = isBusy ? label || "处理中" : composerActionLabel();
  updateComposerAvailability();
  syncComposerMetrics();
  refreshComposerStatusBar();
  if (!isBusy) refreshStatus({ silentAuthFailure: true });
}

function updateComposerAvailability() {
  const hasProject = Boolean(elements.codexProject.value);
  const hasDraft = Boolean(elements.codexPrompt.value.trim()) || composerAttachments.length > 0;
  const blockedBySelectedSession = selectedSessionNeedsExplicitNew();
  elements.sendCodexButton.disabled = composerBusy || !hasProject || !hasDraft || blockedBySelectedSession;
  elements.sendCodexButton.textContent = composerBusy
    ? elements.sendCodexButton.textContent
    : composerActionLabel();
  elements.newCodexSessionButton.disabled = composerBusy;
  elements.codexProject.disabled = composerBusy;
  elements.codexPermissionMode.disabled = composerBusy;
  elements.codexModel.disabled = composerBusy;
  elements.codexReasoningEffort.disabled = composerBusy;
  elements.codexPrompt.disabled = composerBusy;
  elements.composerAttachmentButton.disabled = composerBusy;
  refreshComposerMeta();
  refreshTopbarProjectChip();
  syncComposerMetrics();
  refreshComposerStatusBar();
}

function renderProjectPicker(agentOnline) {
  const selectedWorkspace = codexWorkspaces.find((workspace) => workspace.id === elements.codexProject.value) || null;
  const hasProjects = codexWorkspaces.length > 0;
  elements.projectSidebarCard.classList.toggle("empty", !selectedWorkspace);

  if (!hasProjects) {
    elements.projectPickerLabel.textContent = agentOnline ? "还没有授权工程目录" : "等待桌面 agent";
    elements.projectPickerMeta.textContent = agentOnline
      ? "去桌面端 Codex 设置添加允许的项目。"
      : "桌面端启动后会同步可切换项目。";
    elements.composerProjectLabel.textContent = elements.projectPickerLabel.textContent;
    elements.projectSheetStatus.textContent = "";
    renderProjectSheetList();
    refreshActiveSessionHeader();
    refreshTopbarProjectChip();
    return;
  }

  if (selectedWorkspace) {
    elements.projectPickerLabel.textContent = workspaceLabel(selectedWorkspace);
    elements.projectPickerMeta.textContent = workspaceMeta(selectedWorkspace);
    elements.composerProjectLabel.textContent = workspaceLabel(selectedWorkspace);
  } else {
    elements.projectPickerLabel.textContent = "选择项目";
    elements.projectPickerMeta.textContent = `已同步 ${codexWorkspaces.length} 个项目。`;
    elements.composerProjectLabel.textContent = elements.projectPickerLabel.textContent;
  }

  elements.projectSheetStatus.textContent = "";
  renderProjectSheetList();
  refreshActiveSessionHeader();
  refreshTopbarProjectChip();
}

function renderProjectSheetList() {
  elements.projectSheetList.innerHTML = "";
  if (!codexWorkspaces.length) {
    elements.projectSheetList.innerHTML = '<div class="project-sheet-empty">暂时没有可切换工程。</div>';
    return;
  }

  for (const workspace of codexWorkspaces) {
    const button = document.createElement("button");
    const isActive = workspace.id === elements.codexProject.value;
    const secondaryLabel = workspaceSecondaryLabel(workspace);
    const pathLabel = workspacePathLabel(workspace) || workspaceMeta(workspace);
    button.type = "button";
    button.className = "project-option";
    button.dataset.projectId = workspace.id || "";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", isActive ? "true" : "false");
    button.classList.toggle("active", isActive);
    button.innerHTML = `
      <div class="project-option-main">
        <div class="project-option-title-row">
          <strong>${escapeHtml(workspaceLabel(workspace))}</strong>
          ${isActive ? '<span class="project-option-badge">当前</span>' : ""}
        </div>
        ${secondaryLabel ? `<span class="project-option-id">${escapeHtml(secondaryLabel)}</span>` : ""}
        <span class="project-option-path">${escapeHtml(pathLabel)}</span>
      </div>
    `;
    button.addEventListener("click", () => selectProject(workspace.id));
    elements.projectSheetList.append(button);
  }
}

function handleGlobalKeydown(event) {
  if (event.key !== "Escape") return;
  if (elements.codexView.classList.contains("sessions-open")) {
    event.preventDefault();
    closeSessionSidebar();
  }
}

function selectProject(projectId) {
  if (!projectId) return;
  const previous = elements.codexProject.value;
  elements.codexProject.value = projectId;
  localStorage.setItem("echoCodexProject", projectId);
  syncProjectPicker();
  updateComposerAvailability();
  if (previous && previous !== projectId) {
    toast(`已切换到 ${workspaceLabel(codexWorkspaces.find((workspace) => workspace.id === projectId) || { id: projectId })}`);
  }
}

function syncProjectPicker() {
  const workspace = codexWorkspaces.find((item) => item.id === elements.codexProject.value);
  if (workspace) {
    elements.projectPickerLabel.textContent = workspaceLabel(workspace);
    elements.projectPickerMeta.textContent = workspaceMeta(workspace);
    elements.composerProjectLabel.textContent = workspaceLabel(workspace);
  } else {
    elements.composerProjectLabel.textContent = elements.projectPickerLabel.textContent;
  }
  elements.projectSidebarCard.classList.toggle("empty", !workspace);
  refreshTopbarProjectChip();
  renderProjectSheetList();
  refreshActiveSessionHeader();
}

function workspaceLabel(workspace) {
  return workspace?.label || workspace?.id || workspace?.path || "未命名项目";
}

function workspaceMeta(workspace) {
  return workspace?.path || workspace?.id || "桌面端已同步";
}

function workspaceSecondaryLabel(workspace) {
  if (!workspace?.id) return "";
  return workspace.label && workspace.label !== workspace.id ? workspace.id : "";
}

function workspacePathLabel(workspace) {
  if (!workspace?.path) return "";
  return workspace.path !== workspace.id ? workspace.path : "";
}

async function loadCodexJobs() {
  const data = await apiGet(`/api/codex/sessions?archived=${showArchivedSessions ? "true" : "false"}`);
  const jobs = data.items.slice(0, 30).filter(matchesSessionSearch);
  elements.codexJobs.innerHTML = "";
  if (jobs.length === 0) {
    const emptyCopy = sessionSearchQuery
      ? "没有匹配的会话"
      : showArchivedSessions
        ? "还没有归档会话"
        : "还没有 Codex 会话";
    elements.codexJobs.innerHTML = `<div class="empty-state">${escapeHtml(emptyCopy)}</div>`;
    selectedCodexSession = null;
    if (!composingNewSession) {
      selectedCodexJobId = "";
      applyRuntimeDraft(runtimePreferences, { persist: false, dirty: false });
      renderEmptySessionDetail({
        title: showArchivedSessions ? "归档" : "新会话",
        body: showArchivedSessions ? "这里暂时没有归档会话。" : "直接发送，开始新的 Codex 会话。"
      });
    }
    return;
  }

  if (!selectedCodexJobId && !composingNewSession) {
    selectedCodexJobId = preferredSession(jobs)?.id || jobs[0].id;
  } else if (selectedCodexJobId && !jobs.some((job) => job.id === selectedCodexJobId)) {
    selectedCodexJobId = composingNewSession ? "" : preferredSession(jobs)?.id || jobs[0].id;
  }

  for (const job of jobs) {
    elements.codexJobs.append(renderSessionButton(job));
  }

  if (selectedCodexJobId) {
    await showCodexJob(selectedCodexJobId, { keepSelection: true });
  } else {
    selectedCodexSession = null;
    applyRuntimeDraft(runtimePreferences, { persist: false, dirty: false });
    renderEmptySessionDetail({ title: "新会话", body: "直接发送，开始新的 Codex 会话。" });
  }
}

function renderSessionButton(job) {
  const item = document.createElement("div");
  item.dataset.jobId = job.id;
  item.className = "conversation-item";
  item.classList.toggle("active", job.id === selectedCodexJobId);
  const archived = Boolean(job.archivedAt);
  const canArchive = !["queued", "starting", "running"].includes(job.status) && !job.pendingApprovalCount && !job.pendingCommandCount;
  item.innerHTML = `
    <button class="conversation-item-open" type="button">
      <div class="conversation-item-head">
        <strong>${escapeHtml(jobTitle(job))}</strong>
        <span class="conversation-item-time">${escapeHtml(formatRelativeTime(sessionTime(job)))}</span>
      </div>
      <div class="conversation-item-meta">
        <span class="conversation-item-status ${escapeHtml(job.status)}">${escapeHtml(statusLabel(job.status))}</span>
        <span>${escapeHtml(sessionProjectLabel(job.projectId))}</span>
      </div>
      <span class="conversation-item-preview">${escapeHtml(jobPreview(job))}</span>
      ${job.pendingApprovalCount ? `<span class="conversation-item-alert">${escapeHtml(job.pendingApprovalCount)} 个待审批</span>` : ""}
    </button>
    <button class="conversation-item-archive" type="button" ${canArchive || archived ? "" : "disabled"}>
      ${archived ? "恢复" : "归档"}
    </button>
  `;
  item.querySelector(".conversation-item-open").addEventListener("click", () => {
    composingNewSession = false;
    showCodexJob(job.id);
    closeSessionSidebar({ restoreFocus: false });
  });
  item.querySelector(".conversation-item-archive").addEventListener("click", () => archiveSession(job.id, !archived));
  return item;
}

async function archiveSession(sessionId, archived) {
  try {
    await apiPost(`/api/codex/sessions/${encodeURIComponent(sessionId)}/archive`, { archived });
    toast(archived ? "已归档" : "已恢复");
    if (sessionId === selectedCodexJobId) {
      selectedCodexJobId = "";
      selectedCodexSession = null;
      renderEmptySessionDetail(archived ? { title: "已归档", body: "这个会话已移到归档。" } : { title: "已恢复", body: "这个会话已经回到最近列表。" });
    }
    await loadCodexJobs();
  } catch (error) {
    if (!handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
      toast(error.message);
    }
  }
}

function matchesSessionSearch(job) {
  if (!sessionSearchQuery) return true;
  const haystack = [
    jobTitle(job),
    job.projectId,
    sessionProjectLabel(job.projectId),
    jobPreview(job),
    sessionRuntimeLabel(job.runtime),
    job.status,
    job.finalMessage,
    job.lastError
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(sessionSearchQuery);
}

function preferredSession(jobs) {
  return (
    jobs.find((job) => job.pendingApprovalCount > 0) ||
    jobs.find((job) => ["queued", "starting", "running"].includes(job.status)) ||
    jobs.find((job) => job.status === "active") ||
    jobs[0]
  );
}

function sessionGroups(jobs) {
  const needsAction = [];
  const running = [];
  const continuable = [];
  const history = [];

  for (const job of jobs) {
    if (job.pendingApprovalCount > 0) needsAction.push(job);
    else if (["queued", "starting", "running"].includes(job.status)) running.push(job);
    else if (job.status === "active") continuable.push(job);
    else history.push(job);
  }

  return [
    ...(showArchivedSessions ? [{ title: "归档", items: jobs }] : []),
    ...(!showArchivedSessions
      ? [
          { title: "需要处理", items: needsAction },
          { title: "运行中", items: running },
          { title: "可继续", items: continuable },
          { title: "历史", items: history }
        ]
      : [])
  ];
}

function statusLabel(status) {
  return {
    queued: "排队中",
    starting: "启动中",
    active: "可继续",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    closed: "已关闭",
    stale: "已过期"
  }[status] || status || "未知";
}

async function showCodexJob(id, options = {}) {
  const previousSessionId = selectedCodexJobId;
  const switchingSession = Boolean(previousSessionId && previousSessionId !== id);
  selectedCodexJobId = id;
  if (options.resetComposerAttachments || switchingSession) {
    clearComposerAttachments({ silent: true });
  }
  if (!options.keepSelection) {
    for (const button of elements.codexJobs.querySelectorAll(".conversation-item")) {
      button.classList.toggle("active", button.dataset.jobId === id);
    }
  }
  const data = await apiGet(`/api/codex/sessions/${encodeURIComponent(id)}`);
  const job = data.session;
  selectedCodexSession = job;
  if (!(options.keepSelection && runtimeDirty)) {
    applyRuntimeDraft(job.runtime || runtimePreferences, { persist: false, dirty: false });
  }
  const errorText = humanizeCodexError(job.error || job.lastError);
  elements.codexJobDetail.hidden = false;
  elements.runLog.hidden = false;
  elements.activeSessionTitle.textContent = jobTitle(job);
  elements.codexRunSummary.innerHTML = `
    <div class="conversation-thread">
      ${renderConversationThread(job, errorText)}
    </div>
  `;
  renderApprovals(job);
  const lines = [
    `# ${job.status} · ${job.projectId}`,
    errorText ? `ERROR: ${errorText}` : "",
    job.finalMessage ? `\nFinal:\n${job.finalMessage}` : "",
    "\nEvents:",
    ...(job.events || []).slice(-80).map((event) => `${event.at || ""} ${event.type || ""}\n${event.text || ""}`)
  ].filter(Boolean);
  elements.codexLog.textContent = lines.join("\n\n");
  refreshActiveSessionHeader();
  updateComposerAvailability();
  resetTopbarScrollTracking({ forceVisible: true });
}

function renderEmptySessionDetail({ title, body }) {
  elements.codexJobDetail.hidden = false;
  elements.activeSessionTitle.textContent = title;
  elements.codexApprovals.hidden = true;
  elements.codexApprovals.innerHTML = "";
  elements.runLog.hidden = true;
  elements.codexLog.textContent = "";
  elements.codexRunSummary.innerHTML = `
    <div class="conversation-thread conversation-thread-empty">
      <div class="thread-welcome">
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(body)}</p>
      </div>
    </div>
  `;
  refreshActiveSessionHeader();
  resetTopbarScrollTracking({ forceVisible: true });
}

function renderApprovals(session) {
  const approvals = session.approvals || [];
  elements.codexApprovals.hidden = approvals.length === 0;
  elements.codexApprovals.innerHTML = "";
  for (const approval of approvals) {
    const node = document.createElement("div");
    node.className = "approval-inline-card";
    node.innerHTML = `
      <div class="approval-inline-copy">
        <span class="thread-status-pill warn">${escapeHtml(approvalTitle(approval))}</span>
        <p>${escapeHtml(approval.prompt || approval.method || "Codex 请求审批")}</p>
        <pre>${escapeHtml(approvalDetail(approval))}</pre>
      </div>
      <div class="approval-actions">
        <button class="secondary" type="button" data-decision="denied">拒绝</button>
        <button class="primary" type="button" data-decision="approved">批准</button>
      </div>
    `;
    for (const button of node.querySelectorAll("button")) {
      button.addEventListener("click", () => decideApproval(session.id, approval.id, button.dataset.decision));
    }
    elements.codexApprovals.append(node);
  }
}

async function decideApproval(sessionId, approvalId, decision) {
  try {
    await apiPost(`/api/codex/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, {
      decision
    });
    toast(decision === "approved" ? "已批准" : "已拒绝");
    await showCodexJob(sessionId, { keepSelection: true });
  } catch (error) {
    if (!handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
      toast(error.message);
    }
  }
}

function approvalTitle(approval) {
  if (approval.method === "item/commandExecution/requestApproval" || approval.method === "execCommandApproval") return "命令审批";
  if (approval.method === "item/fileChange/requestApproval" || approval.method === "applyPatchApproval") return "文件修改审批";
  return "Codex 审批";
}

function approvalDetail(approval) {
  const payload = approval.payload || {};
  if (payload.command) return Array.isArray(payload.command) ? payload.command.join(" ") : String(payload.command);
  if (payload.cwd || payload.reason) return [payload.cwd, payload.reason].filter(Boolean).join("\n");
  if (payload.grantRoot) return String(payload.grantRoot);
  if (payload.changes) return payload.changes.map((change) => change.path || change.kind || "").filter(Boolean).join("\n");
  return JSON.stringify(payload, null, 2).slice(0, 1600);
}

function renderConversationThread(job, errorText = "") {
  const timeline = buildConversationTimeline(job, errorText);
  return timeline.map(renderConversationEntry).join("");
}

function buildConversationTimeline(job, errorText = "") {
  const timeline = [];
  const events = Array.isArray(job.events) ? job.events : [];

  for (const event of events) {
    const userText = event.type === "user.message" ? String(event.text || "").trim() : "";
    const userAttachments = event.type === "user.message" ? userMessageAttachments(event) : [];
    if (userText || userAttachments.length > 0) {
      timeline.push({
        kind: "message",
        role: "user",
        text: userText,
        attachments: userAttachments,
        at: event.at || job.createdAt || ""
      });
      continue;
    }

    const assistantText = assistantMessageText(event);
    if (!assistantText) continue;
    if (lastTimelineMessageText(timeline, "assistant") === assistantText) continue;
    timeline.push({
      kind: "message",
      role: "assistant",
      text: assistantText,
      at: event.at || job.updatedAt || ""
    });
  }

  const draftAssistantText = activeAssistantDraft(job, timeline);
  if (draftAssistantText) {
    timeline.push({
      kind: "message",
      role: "assistant",
      text: draftAssistantText,
      at: job.updatedAt || job.createdAt || "",
      draft: job.status === "starting" || job.status === "running"
    });
  }

  if (errorText && !timeline.some((entry) => entry.kind === "error" && entry.text === errorText)) {
    timeline.push({
      kind: "error",
      text: errorText,
      at: job.updatedAt || job.createdAt || ""
    });
  }

  if (timeline.length === 0) {
    timeline.push({
      kind: "empty",
      title: "还没有消息",
      body: "从下面发第一句话开始。"
    });
  }

  return timeline;
}

function renderConversationEntry(entry) {
  if (entry.kind === "status") {
    return `
      <div class="thread-status-row">
        <span class="thread-status-pill">${escapeHtml(entry.text)}</span>
      </div>
    `;
  }

  if (entry.kind === "error") {
    return `
      <article class="thread-message thread-message-system">
        <div class="thread-bubble thread-bubble-error">${escapeHtml(entry.text)}</div>
      </article>
    `;
  }

  if (entry.kind === "empty") {
    return `
      <div class="thread-welcome">
        <strong>${escapeHtml(entry.title)}</strong>
        <p>${escapeHtml(entry.body)}</p>
      </div>
    `;
  }

  const roleLabel = entry.role === "user" ? "你" : "Codex";
  const roleClass = entry.role === "user" ? "thread-message-user" : "thread-message-assistant";
  const bubbleClass = entry.role === "user" ? "thread-bubble-user" : "thread-bubble-assistant";
  const draftBadge = entry.draft ? '<span class="thread-draft-badge">回复中</span>' : "";
  const timeLabel = entry.at ? formatMessageTime(entry.at) : "";
  const hasText = Boolean(entry.text);
  const attachmentsHtml = renderConversationAttachments(entry.attachments || []);

  return `
    <article class="thread-message ${roleClass}">
      <div class="thread-message-meta">
        <span class="thread-message-role">${roleLabel}</span>
        ${draftBadge}
        ${timeLabel ? `<span class="thread-message-time">${escapeHtml(timeLabel)}</span>` : ""}
      </div>
      ${hasText ? `<div class="thread-bubble ${bubbleClass}">${escapeHtml(entry.text)}</div>` : ""}
      ${attachmentsHtml}
    </article>
  `;
}

function assistantMessageText(event) {
  const item = event.raw?.params?.item;
  if (event.type === "item/completed" && item?.type === "agentMessage") {
    return String(item.text || event.text || "").trim();
  }
  return "";
}

function activeAssistantDraft(job, timeline) {
  const current = String(job.finalMessage || "").trim();
  if (!current) return "";
  if (lastTimelineMessageText(timeline, "assistant") === current) return "";
  return current;
}

function lastTimelineMessageText(timeline, role) {
  const item = [...timeline].reverse().find((entry) => entry.kind === "message" && entry.role === role);
  return item?.text || "";
}

function userMessageAttachments(event) {
  const attachments = Array.isArray(event.raw?.attachments) ? event.raw.attachments : [];
  return attachments.filter((attachment) => attachment?.type === "image" && typeof attachment.url === "string");
}

function renderConversationAttachments(attachments = []) {
  if (!attachments.length) return "";
  return `
    <div class="thread-attachments">
      ${attachments
        .map((attachment, index) => {
          const label = attachmentDisplayLabel(attachment, index);
          return `
            <div class="thread-attachment-pill">
              <span class="thread-attachment-pill-label">${escapeHtml(label)}</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function attachmentDisplayLabel(attachment, index = 0) {
  const name = String(attachment?.name || "").trim();
  return name || `截图 ${index + 1}`;
}

function attachmentSummaryText(attachments = [], prefix = "附加") {
  const count = Array.isArray(attachments) ? attachments.length : 0;
  return `${prefix} ${count} 个附件`;
}

function conversationStatusHint(job, hasTimeline) {
  if (job.pendingApprovalCount > 0) return "等待你的审批后继续。";
  if (job.pendingCommandCount > 0 && job.status === "running") return "新消息已记住，会接在当前回复里继续。";
  if (job.pendingCommandCount > 0 && job.status === "active") return "新消息已排队，等待桌面端继续这一话题。";
  if (job.status === "queued") return "已发送，等待桌面端接手。";
  if (job.status === "starting") return "Codex 正在启动这轮对话。";
  if (job.status === "running") return hasTimeline ? "Codex 正在继续回复。" : "Codex 正在思考。";
  if (job.status === "active" && hasTimeline) return "这轮结束了，可以继续追问。";
  if (job.status === "failed" && !job.lastError) return "这轮对话失败了。";
  return "";
}

function jobOutput(job, errorText = "") {
  if (errorText) return { className: "run-error", text: errorText };
  if (job.finalMessage) return { className: "run-final", text: job.finalMessage };

  const event = latestVisibleEvent(job.events || []);
  if (event?.text) return { className: "run-output", text: event.text };

  if (job.status === "queued") {
    return { className: "run-output muted", text: "已进入会话队列，等待桌面 agent 领取。" };
  }
  if (job.status === "starting" || job.status === "running") {
    return { className: "run-output muted", text: "桌面 Codex 正在运行，输出会自动刷新到这里。" };
  }
  if (job.status === "active") {
    return { className: "run-output muted", text: "这一轮已结束，可以继续补充新消息。" };
  }
  return { className: "run-output muted", text: "暂无输出。" };
}

function latestVisibleEvent(events) {
  return [...events].reverse().find((event) => {
    if (!event?.text) return false;
    return !["lease.acquired", "lease.expired", "job.completed", "job.failed"].includes(event.type);
  });
}

function jobPreview(job) {
  const error = job.error || job.lastError || "";
  if (error) return humanizeCodexError(error).split("\n")[0].slice(0, 140);
  if (job.finalMessage) return job.finalMessage.slice(0, 140);
  return sessionPrompt(job).slice(0, 140);
}

function jobTitle(job) {
  return compactSessionTitle(sessionPrompt(job) || job.title || "Codex 会话");
}

function sessionPrompt(session) {
  const userEvent = (session.events || []).find((event) => event.type === "user.message");
  return userEvent?.text || session.title || "";
}

function compactSessionTitle(value) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/没有办法|没办法/g, "无法")
    .replace(/上下滑动/g, "上下滚动")
    .replace(/这个|那个/g, "")
    .trim();
  if (!normalized) return "Codex 会话";

  const sentence = normalized
    .split(/[\r\n]+|[。！？!?；;]/)
    .map((part) => part.trim())
    .find(Boolean) || normalized;

  const clause = firstTitleClause(sentence) || sentence;
  const cleaned = clause
    .replace(/^(?:现在|目前|帮我|麻烦|请你|请|顺手|另外|还有|然后|再)\s*/u, "")
    .trim();

  return truncateSessionTitle(cleaned || sentence || normalized);
}

function firstTitleClause(text) {
  const separators = [/但是|不过|然后|另外|还有|顺手|同时|并且|而且|以及/u, /[，,：:]/u];
  for (const separator of separators) {
    const match = text.match(separator);
    if (match?.index > 6) return text.slice(0, match.index).trim();
  }
  return text.trim();
}

function truncateSessionTitle(text) {
  const compact = String(text || "").trim();
  if (!compact) return "Codex 会话";
  return compact.length > 28 ? `${compact.slice(0, 28).trimEnd()}…` : compact;
}

function sessionTime(session) {
  return session.updatedAt || session.completedAt || session.startedAt || session.createdAt;
}

function refreshActiveSessionHeader() {
  const session = composingNewSession ? null : selectedCodexSession;
  const runtime = runtimeDirty ? currentRuntimeDraft() : session?.runtime || runtimePreferences;
  const parts = [];
  const runtimeLabel = sessionRuntimeLabel(runtime);
  if (runtimeLabel) parts.push(runtimeLabel);
  if (session) {
    parts.push(session.archivedAt ? "已归档" : statusLabel(session.status));
    parts.push(formatRelativeTime(sessionTime(session)));
  }
  elements.activeSessionMeta.textContent = parts.filter(Boolean).join(" · ") || "选择权限、模型和推理强度后直接发送。";
  refreshComposerMeta();
  refreshComposerStatusBar();
}

function refreshComposerMeta() {
  if (!elements.composerActionsMeta) return;
  if (composerBusy) {
    elements.composerActionsMeta.textContent = "Codex 正在处理这一轮消息。";
    return;
  }
  if (!elements.codexProject.value) {
    elements.composerActionsMeta.textContent = "先在左侧选择工程，再开始对话。";
    return;
  }
  const session = composingNewSession ? null : selectedCodexSession;
  const runtime = runtimeDirty ? currentRuntimeDraft() : session?.runtime || runtimePreferences;
  const runtimeLabel = sessionRuntimeLabel(runtime) || "桌面默认";
  const modeLabel = postprocessEnabled ? "后处理" : "原文";
  if (session && !sessionCanAcceptFollowUp(session)) {
    elements.composerActionsMeta.textContent = `当前会话不可继续，请先从左上角新建会话 · ${runtimeLabel} · ${modeLabel}`;
    return;
  }
  const lead = session ? (sessionHasPendingWork(session) ? "继续当前话题，接在这一轮后面" : "继续当前话题") : "发送后创建新话题";
  elements.composerActionsMeta.textContent = `${lead} · ${sessionProjectLabel(session?.projectId || elements.codexProject.value)} · ${runtimeLabel} · ${modeLabel}`;
}

function refreshTopbarProjectChip() {
  if (!elements.topbarProjectChip) return;
  const label = String(elements.composerProjectLabel?.textContent || "").trim();
  const hide =
    !isLoggedIn() ||
    !token ||
    !label ||
    label === "选择项目" ||
    label === "等待桌面 agent" ||
    label === "还没有授权工程目录";
  elements.topbarProjectChip.hidden = hide;
}

function formatRelativeTime(value) {
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
}

function formatMessageTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function sessionProjectLabel(projectId) {
  const normalizedProjectId = String(projectId || "").trim();
  if (!normalizedProjectId) return "未选择工程";
  return workspaceLabel(codexWorkspaces.find((workspace) => workspace.id === normalizedProjectId) || { id: normalizedProjectId });
}

function sessionRuntimeLabel(runtime = {}) {
  const normalized = normalizeRuntimeChoice(runtime);
  const parts = [];
  if (normalized.permissionMode) parts.push(permissionModeDisplayName(normalized.permissionMode));
  if (normalized.model) parts.push(modelDisplayName(normalized.model));
  if (normalized.reasoningEffort) parts.push(`推理 ${reasoningDisplayName(normalized.reasoningEffort)}`);
  return parts.join(" · ");
}

function normalizePermissionMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "readonly" || normalized === "read-only" || normalized === "suggest") return "strict";
  if (normalized === "approve" || normalized === "approved" || normalized === "auto" || normalized === "auto-edit") return "approve";
  if (normalized === "full" || normalized === "full-auto" || normalized === "fullaccess") return "full";
  return PERMISSION_MODE_OPTIONS.some((option) => option.value === normalized) ? normalized : "";
}

function permissionModeFromRuntime(runtime = {}) {
  const sandbox = normalizeSandboxModeValue(runtime.sandbox);
  if (sandbox === "read-only") return "strict";
  if (sandbox === "danger-full-access") return "full";
  if (sandbox === "workspace-write") return "approve";
  return "";
}

function permissionRuntimeForMode(mode) {
  const normalized = normalizePermissionMode(mode);
  if (normalized === "strict") return { sandbox: "read-only", approvalPolicy: "on-request" };
  if (normalized === "full") return { sandbox: "danger-full-access", approvalPolicy: "never" };
  if (normalized === "approve") return { sandbox: "workspace-write", approvalPolicy: "on-request" };
  return { sandbox: "", approvalPolicy: "" };
}

function normalizeSandboxModeValue(value) {
  const normalized = String(value || "").trim();
  if (normalized === "workspaceWrite") return "workspace-write";
  if (normalized === "dangerFullAccess") return "danger-full-access";
  if (normalized === "readOnly") return "read-only";
  return normalized;
}

function normalizeApprovalPolicyValue(value) {
  return String(value || "").trim().toLowerCase();
}

function permissionModeDisplayName(value) {
  const normalized = normalizePermissionMode(value);
  return PERMISSION_MODE_OPTIONS.find((option) => option.value === normalized)?.label || normalized;
}

function modelDisplayName(value) {
  const normalized = String(value || "").trim();
  return MODEL_OPTIONS.find((option) => option.value === normalized)?.label || normalized;
}

function reasoningDisplayName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return REASONING_OPTIONS.find((option) => option.value === normalized)?.label || normalized;
}

function humanizeCodexError(error) {
  const text = String(error || "").trim();
  if (!text) return "";
  if (/requires a newer version of Codex|Please upgrade to the latest app or CLI/i.test(text)) {
    return `${text}\n\n处理方式：在桌面端设置里把 Codex 模型固定为当前 CLI 支持的模型，或升级 Codex CLI。`;
  }
  if (/ENOENT|No such file or directory/i.test(text)) {
    return `${text}\n\n处理方式：检查桌面端 Codex command，必要时填入 codex 的绝对路径。`;
  }
  return text;
}

function updatePostprocessUi() {
  elements.postprocessToggle.checked = postprocessEnabled;
  elements.postprocessLabel.textContent = postprocessEnabled ? "后处理" : "原文";
  elements.postprocessToggle.closest(".postprocess-toggle")?.classList.toggle("off", !postprocessEnabled);
  refreshComposerMeta();
}

function isAuthError(error) {
  return error.status === 401 || error.code === "SESSION_REQUIRED" || error.code === "PAIRING_REQUIRED";
}

function authHeaders() {
  return {
    ...sessionHeaders(),
    ...(token ? { "X-Echo-Token": token } : {})
  };
}

function sessionHeaders() {
  return authEnabled && sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
}

function ensureLoggedIn() {
  if (isLoggedIn()) return true;
  updateAuthView("请先登录。");
  elements.loginUsername.focus({ preventScroll: true });
  return false;
}

function ensurePaired() {
  if (!ensureLoggedIn()) return false;
  if (token) return true;
  updateAuthView("请先扫码配对。");
  showPairingPanel({ focus: true });
  return false;
}

async function apiGet(path) {
  const response = await fetch(path, { headers: authHeaders() });
  return parseApiResponse(response);
}

async function apiPost(path, body, options = {}) {
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
        ...authHeaders()
      },
      body: JSON.stringify(body),
      signal: controller?.signal
    });
    return parseApiResponse(response);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("请求超时");
    }
    throw error;
  } finally {
    if (timeout) window.clearTimeout(timeout);
  }
}

async function parseApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data.code || "";
    throw error;
  }
  return data;
}

function toast(message) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.append(node);
  window.setTimeout(() => node.remove(), 2600);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
