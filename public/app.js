const params = new URLSearchParams(window.location.search);
const tokenFromUrl = params.get("token");
if (tokenFromUrl) localStorage.setItem("echoToken", tokenFromUrl);
let token = tokenFromUrl || localStorage.getItem("echoToken") || "";
let sessionToken = localStorage.getItem("echoSession") || "";
let currentUser = readStoredUser();
let authEnabled = true;
if (tokenFromUrl) {
  window.history.replaceState({}, "", window.location.pathname);
}

const elements = {
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
  workspaceTabs: document.querySelector("#workspaceTabs"),
  viewTabs: Array.from(document.querySelectorAll(".workspace-tab")),
  viewPanels: Array.from(document.querySelectorAll("[data-view-panel]")),
  modes: Array.from(document.querySelectorAll(".mode")),
  contextHint: document.querySelector("#contextHint"),
  rawText: document.querySelector("#rawText"),
  finalText: document.querySelector("#finalText"),
  postprocessToggle: document.querySelector("#postprocessToggle"),
  postprocessLabel: document.querySelector("#postprocessLabel"),
  refineButton: document.querySelector("#refineButton"),
  copyButton: document.querySelector("#copyButton"),
  queueDraftButton: document.querySelector("#queueDraftButton"),
  codexStatusText: document.querySelector("#codexStatusText"),
  codexQueueMeta: document.querySelector("#codexQueueMeta"),
  codexRuntimeText: document.querySelector("#codexRuntimeText"),
  refreshCodex: document.querySelector("#refreshCodex"),
  codexProject: document.querySelector("#codexProject"),
  codexPrompt: document.querySelector("#codexPrompt"),
  useFinalForCodexButton: document.querySelector("#useFinalForCodexButton"),
  sendCodexButton: document.querySelector("#sendCodexButton"),
  codexJobs: document.querySelector("#codexJobs"),
  codexJobDetail: document.querySelector("#codexJobDetail"),
  codexRunSummary: document.querySelector("#codexRunSummary"),
  codexLog: document.querySelector("#codexLog"),
  history: document.querySelector("#history")
};

let mode = "chat";
let serverStatus = null;
let codexTimer = null;
let pairingStream = null;
let pairingScanActive = false;
let pairingScanBusy = false;
let activeView = localStorage.getItem("echoActiveView") || "codex";
let selectedCodexJobId = "";
let postprocessEnabled = localStorage.getItem("echoPostprocessEnabled") !== "false";
let controlsBusy = false;

elements.loginForm.addEventListener("submit", login);
elements.logoutButton.addEventListener("click", logout);
elements.openPairingButton.addEventListener("click", () => showPairingPanel({ focus: true }));
elements.refreshStatus.addEventListener("click", refreshStatus);
elements.scanPairingButton.addEventListener("click", startPairingScanner);
elements.stopScanButton.addEventListener("click", stopPairingScanner);
elements.savePairingButton.addEventListener("click", pairFromInput);
elements.postprocessToggle.addEventListener("change", () => {
  postprocessEnabled = elements.postprocessToggle.checked;
  localStorage.setItem("echoPostprocessEnabled", postprocessEnabled ? "true" : "false");
  updatePostprocessUi();
  toast(postprocessEnabled ? "后处理已开启" : "后处理已关闭");
});
elements.refineButton.addEventListener("click", refineCurrentText);
elements.copyButton.addEventListener("click", copyFinalText);
elements.queueDraftButton.addEventListener("click", queueDraftForCodex);
elements.refreshCodex.addEventListener("click", refreshCodex);
elements.useFinalForCodexButton.addEventListener("click", useFinalForCodex);
elements.sendCodexButton.addEventListener("click", sendToCodex);
elements.codexProject.addEventListener("change", () => {
  localStorage.setItem("echoCodexProject", elements.codexProject.value);
});

for (const button of elements.viewTabs) {
  button.addEventListener("click", () => setActiveView(button.dataset.view));
}

for (const button of elements.modes) {
  button.addEventListener("click", () => {
    mode = button.dataset.mode;
    elements.modes.forEach((item) => item.classList.toggle("active", item === button));
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

updatePostprocessUi();
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
  await loadHistory();
  if (!token) return;
  await refreshCodex();
  if (!codexTimer) codexTimer = window.setInterval(refreshCodex, 3500);
}

function updateAuthView(message = "") {
  const loggedIn = isLoggedIn();
  const paired = Boolean(token);
  elements.loginPanel.hidden = loggedIn;
  elements.pairingPanel.hidden = !loggedIn || paired;
  elements.openPairingButton.hidden = !loggedIn || paired;
  elements.refreshStatus.hidden = !loggedIn || !paired;
  elements.userBadge.hidden = !loggedIn;
  elements.logoutButton.hidden = !authEnabled || !loggedIn;
  elements.userBadge.textContent = loggedIn ? displayUser(currentUser) : "";
  for (const node of elements.authenticated) node.hidden = !loggedIn || !paired;

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

  setActiveView(activeView, { skipStorage: true, skipRefresh: true });
}

function setActiveView(view, options = {}) {
  activeView = ["codex", "compose", "history"].includes(view) ? view : "codex";
  if (!options.skipStorage) localStorage.setItem("echoActiveView", activeView);

  for (const button of elements.viewTabs) {
    const selected = button.dataset.view === activeView;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  }

  const showWorkspace = isLoggedIn() && Boolean(token);
  for (const panel of elements.viewPanels) {
    panel.hidden = !showWorkspace || panel.dataset.viewPanel !== activeView;
  }

  if (!showWorkspace || options.skipRefresh) return;
  if (activeView === "codex") refreshCodex();
  if (activeView === "history") loadHistory();
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
  } catch (error) {
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
  updateAuthView(message);
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

function showPairingPanel({ focus = false } = {}) {
  if (!ensureLoggedIn()) return;
  updateAuthView();
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
    serverStatus = status;
    const refine = status.refine.provider === "none" ? "不整理" : `整理 ${status.refine.provider}`;
    const codex = status.codex?.agentOnline ? "Codex 在线" : status.mode === "relay" ? "等待桌面 agent" : status.platform;
    elements.statusText.textContent = `${refine} · ${codex}`;
    if (status.user) setCurrentUser(status.user, { updateView: false });
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

async function refineCurrentText() {
  if (!ensurePaired()) return;
  if (!postprocessEnabled) {
    toast("后处理已关闭");
    return;
  }

  const rawText = elements.rawText.value.trim() || elements.finalText.value.trim();
  if (!rawText) {
    toast("没有可整理的文本");
    return;
  }

  setBusy(true, "整理中");
  try {
    await refineDraft(rawText);
    await loadHistory();
    toast("已更新");
  } catch (error) {
    if (!handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
      toast(error.message);
    }
  } finally {
    setBusy(false);
  }
}

async function copyFinalText() {
  const text = currentDraftText();
  if (!text) {
    toast("没有可复制的文本");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
  } catch (error) {
    toast(error.message || "复制失败，请手动选择文本复制");
  }
}

async function queueDraftForCodex() {
  if (!ensurePaired()) return;

  const rawText = elements.rawText.value.trim();
  const finalText = elements.finalText.value.trim();
  if (!rawText && !finalText) {
    toast("没有可加入队列的任务");
    return;
  }

  setBusy(true, postprocessEnabled && !finalText ? "整理中" : "加入队列中");
  try {
    const text = await draftTextForQueue({ rawText, finalText });
    elements.codexPrompt.value = text;
    setActiveView("codex", { skipRefresh: true });
    await refreshCodex();
    await sendToCodex();
  } catch (error) {
    if (!handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
      toast(error.message);
    }
  } finally {
    setBusy(false);
  }
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
    elements.codexProject.innerHTML = "";
    elements.sendCodexButton.disabled = true;
    if (error.message && !error.message.includes("relay mode")) toast(error.message);
  }
}

function renderCodexStatus(codex) {
  const workspaces = codex.workspaces || [];
  elements.codexStatusText.textContent = codex.agentOnline
    ? `桌面 agent 在线 · ${workspaces.length} 个项目`
    : "等待桌面 agent";
  elements.codexQueueMeta.textContent = `排队 ${codex.queued || 0} · 运行 ${codex.running || 0} · 最近 ${
    codex.recent?.length || 0
  }`;
  const runtime = codex.runtime || {};
  elements.codexRuntimeText.textContent = codex.agentOnline
    ? `${runtime.command || "codex"} · ${runtime.model || "Codex 默认模型"} · ${runtime.sandbox || "workspace-write"}`
    : "请先启动桌面端";

  const selected = localStorage.getItem("echoCodexProject") || elements.codexProject.value;
  elements.codexProject.innerHTML = "";
  for (const workspace of workspaces) {
    const option = document.createElement("option");
    option.value = workspace.id;
    option.textContent = `${workspace.label} · ${workspace.path}`;
    option.selected = workspace.id === selected;
    elements.codexProject.append(option);
  }
  if (elements.codexProject.value) {
    localStorage.setItem("echoCodexProject", elements.codexProject.value);
  }
  elements.sendCodexButton.disabled = !elements.codexProject.value;
}

function useFinalForCodex() {
  const text = currentDraftText();
  if (!text) {
    toast("草稿页还没有可使用的文本");
    return;
  }
  elements.codexPrompt.value = text;
  toast("已填入 Codex 任务");
}

async function sendToCodex() {
  if (!ensurePaired()) return;

  const prompt = elements.codexPrompt.value.trim();
  const projectId = elements.codexProject.value;
  if (!prompt) {
    toast("请先填写 Codex 任务");
    return;
  }
  if (!projectId) {
    toast("桌面 agent 还没有公布项目");
    return;
  }

  localStorage.setItem("echoCodexProject", projectId);
  elements.sendCodexButton.disabled = true;
  try {
    const data = await apiPost("/api/codex/jobs", { projectId, prompt });
    selectedCodexJobId = data.job.id;
    toast("已加入任务队列");
    setActiveView("codex", { skipRefresh: true });
    await loadCodexJobs();
    await showCodexJob(data.job.id);
  } catch (error) {
    if (!handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
      toast(error.message);
    }
  } finally {
    elements.sendCodexButton.disabled = !elements.codexProject.value;
  }
}

async function loadCodexJobs() {
  const data = await apiGet("/api/codex/jobs");
  const jobs = data.items.slice(0, 8);
  elements.codexJobs.innerHTML = "";
  if (jobs.length === 0) {
    elements.codexJobs.innerHTML = `<div class="empty-state">任务队列为空</div>`;
    elements.codexJobDetail.hidden = true;
    return;
  }

  if (!selectedCodexJobId || !jobs.some((job) => job.id === selectedCodexJobId)) {
    selectedCodexJobId = jobs[0].id;
  }

  for (const job of jobs) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.jobId = job.id;
    button.className = "codex-job";
    button.classList.toggle("active", job.id === selectedCodexJobId);
    button.innerHTML = `
      <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(statusLabel(job.status))}</span>
      <strong>${escapeHtml(job.projectId)} · ${escapeHtml(formatRelativeTime(job.completedAt || job.startedAt || job.createdAt))}</strong>
      <span>${escapeHtml(jobPreview(job))}</span>
    `;
    button.addEventListener("click", () => showCodexJob(job.id));
    elements.codexJobs.append(button);
  }

  if (selectedCodexJobId) {
    await showCodexJob(selectedCodexJobId, { keepSelection: true });
  }
}

function statusLabel(status) {
  return {
    queued: "排队中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    stale: "已过期"
  }[status] || status || "未知";
}

async function showCodexJob(id, options = {}) {
  selectedCodexJobId = id;
  if (!options.keepSelection) {
    for (const button of elements.codexJobs.querySelectorAll(".codex-job")) {
      button.classList.toggle("active", button.dataset.jobId === id);
    }
  }
  const data = await apiGet(`/api/codex/jobs/${encodeURIComponent(id)}`);
  const job = data.job;
  const errorText = humanizeCodexError(job.error);
  const output = jobOutput(job, errorText);
  elements.codexJobDetail.hidden = false;
  elements.codexRunSummary.innerHTML = `
    <div class="run-summary-head">
      <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(statusLabel(job.status))}</span>
      <strong>${escapeHtml(job.projectId)}</strong>
      <span>${escapeHtml(formatRelativeTime(job.completedAt || job.startedAt || job.createdAt))}</span>
    </div>
    <div class="run-block-title">任务</div>
    <div class="run-prompt">${escapeHtml(job.prompt || "")}</div>
    <div class="run-block-title">输出</div>
    <div class="${escapeHtml(output.className)}">${escapeHtml(output.text)}</div>
  `;
  const lines = [
    `# ${job.status} · ${job.projectId}`,
    errorText ? `ERROR: ${errorText}` : "",
    job.finalMessage ? `\nFinal:\n${job.finalMessage}` : "",
    "\nEvents:",
    ...(job.events || []).slice(-80).map((event) => `${event.at || ""} ${event.type || ""}\n${event.text || ""}`)
  ].filter(Boolean);
  elements.codexLog.textContent = lines.join("\n\n");
}

function jobOutput(job, errorText = "") {
  if (errorText) return { className: "run-error", text: errorText };
  if (job.finalMessage) return { className: "run-final", text: job.finalMessage };

  const event = latestVisibleEvent(job.events || []);
  if (event?.text) return { className: "run-output", text: event.text };

  if (job.status === "queued") {
    return { className: "run-output muted", text: "已进入队列，等待桌面 agent 领取。" };
  }
  if (job.status === "running") {
    return { className: "run-output muted", text: "桌面 Codex 正在运行，输出会自动刷新到这里。" };
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
  if (job.error) return humanizeCodexError(job.error).split("\n")[0].slice(0, 140);
  if (job.finalMessage) return job.finalMessage.slice(0, 140);
  return job.prompt.slice(0, 140);
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

async function loadHistory() {
  if (!isLoggedIn() || !token) return;

  try {
    const data = await apiGet("/api/history");
    elements.history.innerHTML = "";
    for (const item of data.items.slice(0, 8)) {
      const wrapper = document.createElement("div");
      wrapper.className = "history-item";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.refined || item.raw || "";
      button.addEventListener("click", () => {
        applyItem(item);
        setActiveView("compose");
      });
      wrapper.append(button);
      elements.history.append(wrapper);
    }
  } catch (error) {
    handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。");
    elements.history.innerHTML = "";
  }
}

function applyItem(item) {
  elements.rawText.value = item.raw || "";
  elements.finalText.value = item.refined || "";
}

function setBusy(isBusy, label = "") {
  controlsBusy = isBusy;
  elements.copyButton.disabled = isBusy;
  elements.queueDraftButton.disabled = isBusy;
  updatePostprocessUi();
  if (label) elements.statusText.textContent = label;
  if (!isBusy) refreshStatus();
}

async function refineDraft(rawText) {
  const data = await apiPost("/api/refine", {
    rawText,
    mode,
    contextHint: elements.contextHint.value
  });
  applyItem(data.item);
  return data.item;
}

async function draftTextForQueue({ rawText, finalText }) {
  if (!postprocessEnabled) return rawText || finalText;
  if (finalText) return finalText;

  const item = await refineDraft(rawText);
  await loadHistory();
  return item.refined || item.raw || rawText;
}

function currentDraftText() {
  if (postprocessEnabled) return elements.finalText.value.trim() || elements.rawText.value.trim();
  return elements.rawText.value.trim() || elements.finalText.value.trim();
}

function updatePostprocessUi() {
  elements.postprocessToggle.checked = postprocessEnabled;
  elements.postprocessLabel.textContent = postprocessEnabled ? "后处理" : "原文";
  elements.postprocessToggle.closest(".postprocess-toggle")?.classList.toggle("off", !postprocessEnabled);
  elements.refineButton.disabled = controlsBusy || !postprocessEnabled;
  elements.contextHint.disabled = controlsBusy || !postprocessEnabled;
  elements.finalText.disabled = controlsBusy || !postprocessEnabled;
  for (const button of elements.modes) button.disabled = controlsBusy || !postprocessEnabled;
  elements.finalText.closest(".pane")?.classList.toggle("muted", !postprocessEnabled);
  elements.finalText.placeholder = postprocessEnabled
    ? "整理成任务后，可以在加入队列前继续编辑"
    : "后处理关闭时，加入队列会发送原始输入";
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

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify(body)
  });
  return parseApiResponse(response);
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
