const params = new URLSearchParams(window.location.search);
const tokenFromUrl = params.get("token");
if (tokenFromUrl) localStorage.setItem("echoToken", tokenFromUrl);
let token = tokenFromUrl || localStorage.getItem("echoToken") || "";
let sessionToken = localStorage.getItem("echoSession") || "";
let currentUser = readStoredUser();
let authEnabled = true;
const mobileRefineTimeoutMs = 10000;
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
  codexStatusText: document.querySelector("#codexStatusText"),
  codexQueueMeta: document.querySelector("#codexQueueMeta"),
  refreshCodex: document.querySelector("#refreshCodex"),
  codexProject: document.querySelector("#codexProject"),
  codexPrompt: document.querySelector("#codexPrompt"),
  postprocessToggle: document.querySelector("#postprocessToggle"),
  postprocessLabel: document.querySelector("#postprocessLabel"),
  newCodexSessionButton: document.querySelector("#newCodexSessionButton"),
  sendCodexButton: document.querySelector("#sendCodexButton"),
  codexJobs: document.querySelector("#codexJobs"),
  codexJobDetail: document.querySelector("#codexJobDetail"),
  codexRunSummary: document.querySelector("#codexRunSummary"),
  codexApprovals: document.querySelector("#codexApprovals"),
  codexLog: document.querySelector("#codexLog")
};

let codexTimer = null;
let pairingStream = null;
let pairingScanActive = false;
let pairingScanBusy = false;
let selectedCodexJobId = "";
let selectedCodexSession = null;
let composingNewSession = false;
let postprocessEnabled = localStorage.getItem("echoPostprocessEnabled") !== "false";
let composerBusy = false;

bindViewportMetrics();
elements.loginForm.addEventListener("submit", login);
elements.logoutButton.addEventListener("click", logout);
elements.openPairingButton.addEventListener("click", () => showPairingPanel({ focus: true }));
elements.refreshStatus.addEventListener("click", refreshStatus);
elements.scanPairingButton.addEventListener("click", startPairingScanner);
elements.stopScanButton.addEventListener("click", stopPairingScanner);
elements.savePairingButton.addEventListener("click", pairFromInput);
elements.refreshCodex.addEventListener("click", refreshCodex);
elements.newCodexSessionButton.addEventListener("click", startNewCodexSession);
elements.sendCodexButton.addEventListener("click", sendToCodex);
elements.codexProject.addEventListener("change", () => {
  localStorage.setItem("echoCodexProject", elements.codexProject.value);
  updateComposerAvailability();
});
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

  elements.loginPanel.hidden = loggedIn;
  elements.pairingPanel.hidden = !loggedIn || paired;
  elements.openPairingButton.hidden = !loggedIn || paired;
  elements.refreshStatus.hidden = !showApp;
  elements.userBadge.hidden = !loggedIn;
  elements.logoutButton.hidden = !authEnabled || !loggedIn;
  elements.userBadge.textContent = loggedIn ? displayUser(currentUser) : "";
  for (const node of elements.authenticated) node.hidden = !showApp;

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
    const codexOnline = status.codex?.agentOnline;
    elements.statusText.textContent = codexOnline ? "Codex 在线" : status.mode === "relay" ? "等待桌面 agent" : status.platform;
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
    elements.codexProject.innerHTML = "";
    updateComposerAvailability();
    if (error.message && !error.message.includes("relay mode")) toast(error.message);
  }
}

function renderCodexStatus(codex) {
  const workspaces = codex.workspaces || [];
  elements.codexStatusText.textContent = codex.agentOnline ? "本机 Codex 在线" : "等待桌面 agent";
  elements.codexQueueMeta.textContent = codex.agentOnline
    ? `会话 ${codex.interactive?.activeSessions || 0} · 待审批 ${codex.interactive?.pendingApprovals || 0} · 项目 ${workspaces.length}`
    : "打开桌面端后自动同步";

  const selected = localStorage.getItem("echoCodexProject") || elements.codexProject.value;
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
  updateComposerAvailability();
}

function startNewCodexSession() {
  selectedCodexJobId = "";
  selectedCodexSession = null;
  composingNewSession = true;
  elements.codexJobDetail.hidden = true;
  for (const button of elements.codexJobs.querySelectorAll(".codex-job")) {
    button.classList.remove("active");
  }
  updateComposerAvailability();
  elements.codexPrompt.focus({ preventScroll: true });
}

async function sendToCodex() {
  if (!ensurePaired()) return;

  const rawPrompt = elements.codexPrompt.value.trim();
  const projectId = elements.codexProject.value;
  if (!rawPrompt) {
    toast("请先填写任务");
    return;
  }
  if (!projectId) {
    toast("桌面 agent 还没有公布项目");
    return;
  }

  localStorage.setItem("echoCodexProject", projectId);
  setComposerBusy(true, postprocessEnabled ? "整理中" : "发送中");
  try {
    const prompt = postprocessEnabled ? await refinePromptForCodex(rawPrompt) : rawPrompt;
    setComposerBusy(true, "发送中");
    const data = await sendCodexPrompt({ projectId, prompt });
    selectedCodexJobId = data.session.id;
    selectedCodexSession = data.session;
    composingNewSession = false;
    elements.codexPrompt.value = "";
    toast("已发送");
    await loadCodexJobs();
    await showCodexJob(data.session.id);
    await refreshStatus({ silentAuthFailure: true });
  } catch (error) {
    if (!handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
      toast(error.message);
    }
  } finally {
    setComposerBusy(false);
  }
}

async function sendCodexPrompt({ projectId, prompt }) {
  if (canContinueSelectedSession()) {
    return apiPost(`/api/codex/sessions/${encodeURIComponent(selectedCodexJobId)}/messages`, { text: prompt });
  }
  return apiPost("/api/codex/sessions", { projectId, prompt });
}

function canContinueSelectedSession() {
  if (composingNewSession) return false;
  if (!selectedCodexJobId || !selectedCodexSession) return false;
  return !["failed", "closed", "stale"].includes(selectedCodexSession.status);
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

function setComposerBusy(isBusy, label = "") {
  composerBusy = isBusy;
  if (label) elements.statusText.textContent = label;
  elements.sendCodexButton.textContent = isBusy ? label || "处理中" : canContinueSelectedSession() ? "继续" : "发送";
  updateComposerAvailability();
  if (!isBusy) refreshStatus({ silentAuthFailure: true });
}

function updateComposerAvailability() {
  const hasProject = Boolean(elements.codexProject.value);
  elements.sendCodexButton.disabled = composerBusy || !hasProject;
  elements.sendCodexButton.textContent = composerBusy
    ? elements.sendCodexButton.textContent
    : canContinueSelectedSession()
      ? "继续"
      : "发送";
  elements.newCodexSessionButton.disabled = composerBusy || !selectedCodexJobId;
  elements.codexProject.disabled = composerBusy;
  elements.codexPrompt.disabled = composerBusy;
}

async function loadCodexJobs() {
  const data = await apiGet("/api/codex/sessions");
  const jobs = data.items.slice(0, 8);
  elements.codexJobs.innerHTML = "";
  if (jobs.length === 0) {
    elements.codexJobs.innerHTML = `<div class="empty-state">还没有 Codex 会话</div>`;
    elements.codexJobDetail.hidden = true;
    selectedCodexSession = null;
    return;
  }

  if (!selectedCodexJobId && !composingNewSession) {
    selectedCodexJobId = jobs[0].id;
  } else if (selectedCodexJobId && !jobs.some((job) => job.id === selectedCodexJobId)) {
    selectedCodexJobId = composingNewSession ? "" : jobs[0].id;
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
      ${job.pendingApprovalCount ? `<span class="approval-count">${escapeHtml(job.pendingApprovalCount)} 个待审批</span>` : ""}
    `;
    button.addEventListener("click", () => {
      composingNewSession = false;
      showCodexJob(job.id);
    });
    elements.codexJobs.append(button);
  }

  if (selectedCodexJobId) {
    await showCodexJob(selectedCodexJobId, { keepSelection: true });
  } else {
    selectedCodexSession = null;
    elements.codexJobDetail.hidden = true;
  }
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
  selectedCodexJobId = id;
  if (!options.keepSelection) {
    for (const button of elements.codexJobs.querySelectorAll(".codex-job")) {
      button.classList.toggle("active", button.dataset.jobId === id);
    }
  }
  const data = await apiGet(`/api/codex/sessions/${encodeURIComponent(id)}`);
  const job = data.session;
  selectedCodexSession = job;
  const errorText = humanizeCodexError(job.error || job.lastError);
  const output = jobOutput(job, errorText);
  elements.codexJobDetail.hidden = false;
  elements.codexRunSummary.innerHTML = `
    <div class="run-summary-head">
      <span class="status-pill ${escapeHtml(job.status)}">${escapeHtml(statusLabel(job.status))}</span>
      <strong>${escapeHtml(job.projectId)}</strong>
      <span>${escapeHtml(formatRelativeTime(job.completedAt || job.startedAt || job.createdAt))}</span>
    </div>
    <div class="run-block-title">任务</div>
    <div class="run-prompt">${escapeHtml(sessionPrompt(job))}</div>
    <div class="run-block-title">输出</div>
    <div class="${escapeHtml(output.className)}">${escapeHtml(output.text)}</div>
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
  updateComposerAvailability();
}

function renderApprovals(session) {
  const approvals = session.approvals || [];
  elements.codexApprovals.hidden = approvals.length === 0;
  elements.codexApprovals.innerHTML = "";
  for (const approval of approvals) {
    const node = document.createElement("div");
    node.className = "approval-panel";
    node.innerHTML = `
      <div class="approval-copy">
        <strong>${escapeHtml(approvalTitle(approval))}</strong>
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

function sessionPrompt(session) {
  const userEvent = (session.events || []).find((event) => event.type === "user.message");
  return userEvent?.text || session.title || "";
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

function updatePostprocessUi() {
  elements.postprocessToggle.checked = postprocessEnabled;
  elements.postprocessLabel.textContent = postprocessEnabled ? "后处理" : "原文";
  elements.postprocessToggle.closest(".postprocess-toggle")?.classList.toggle("off", !postprocessEnabled);
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
