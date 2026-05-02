export function installAuth(app) {
  const { elements, localStorage, state, window } = app;

  app.bootUserSession = async function bootUserSession() {
    await app.loadAuthConfig();
    if (!state.authEnabled) {
      state.sessionToken = "";
      state.currentUser = { username: "local", displayName: "Local", role: "owner" };
      localStorage.removeItem("echoSession");
      localStorage.removeItem("echoUser");
      return;
    }
    if (state.sessionToken) {
      await app.refreshCurrentUser({ silent: true });
    }
  };

  app.bootAuthenticated = async function bootAuthenticated() {
    if (!app.isLoggedIn()) {
      app.updateAuthView();
      return;
    }
    app.updateAuthView();
    await app.refreshStatus({ silentAuthFailure: true });
    if (!state.token) return;
    await app.refreshCodex();
    if (!state.codexTimer) {
      state.codexTimer = window.setInterval(app.refreshCodex, 3500);
    }
  };

  app.updateAuthView = function updateAuthView(message = "") {
    const loggedIn = app.isLoggedIn();
    const paired = Boolean(state.token);
    const showApp = loggedIn && paired;

    if (!showApp) {
      app.resetTopbarScrollTracking({ forceVisible: true });
    }

    if (!showApp && elements.codexView.classList.contains("sessions-open")) {
      app.closeSessionSidebar({ restoreFocus: false });
    }

    elements.loginPanel.hidden = loggedIn;
    elements.pairingPanel.hidden = !loggedIn || paired;
    elements.openPairingButton.hidden = !loggedIn;
    elements.openPairingButton.textContent = paired ? "重新配对" : "扫码配对";
    elements.refreshStatus.hidden = !showApp;
    elements.userBadge.hidden = !loggedIn;
    elements.logoutButton.hidden = !state.authEnabled || !loggedIn;
    elements.userBadge.textContent = loggedIn ? app.displayUser(state.currentUser) : "";
    app.renderUserCenter();
    for (const node of elements.authenticated) node.hidden = !showApp;
    app.refreshTopbarProjectChip();

    if (!loggedIn) {
      app.setTopbarStatus("等待登录", "idle");
      elements.loginStatus.textContent = message || "请输入账号后继续。";
      app.queueViewportSync();
      return;
    }

    if (!paired) {
      app.setTopbarStatus("等待配对", "idle");
      elements.pairingStatus.textContent = message || "如果你是直接打开这个网页，请先扫桌面端显示的二维码。";
      app.queueViewportSync();
      return;
    }

    app.setTopbarStatus(message || "连接中", "info");
    app.queueViewportSync();
  };

  app.loadAuthConfig = async function loadAuthConfig() {
    try {
      const response = await fetch("/api/auth/config");
      const data = await app.parseApiResponse(response);
      state.authEnabled = Boolean(data.enabled);
    } catch {
      state.authEnabled = true;
    }
  };

  app.refreshCurrentUser = async function refreshCurrentUser({ silent = false } = {}) {
    try {
      const response = await fetch("/api/auth/me", { headers: app.sessionHeaders() });
      const data = await app.parseApiResponse(response);
      app.setCurrentUser(data.user);
    } catch {
      app.enterLogin(silent ? "" : "登录已过期，请重新登录。");
    }
  };

  app.login = async function login(event) {
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
      const data = await app.parseApiResponse(response);
      state.sessionToken = data.sessionToken || "";
      localStorage.setItem("echoSession", state.sessionToken);
      app.setCurrentUser(data.user);
      elements.loginPassword.value = "";
      app.toast("已登录");
      if (state.token) {
        await app.bootAuthenticated();
      } else {
        app.updateAuthView();
      }
    } catch (error) {
      elements.loginStatus.textContent = error.message || "登录失败";
    } finally {
      elements.loginButton.disabled = false;
    }
  };

  app.logout = function logout() {
    state.sessionToken = "";
    state.currentUser = null;
    localStorage.removeItem("echoSession");
    localStorage.removeItem("echoUser");
    if (state.codexTimer) {
      window.clearInterval(state.codexTimer);
      state.codexTimer = null;
    }
    app.closeCodexSessionStream?.();
    app.stopPairingScanner();
    app.closeSessionSidebar({ restoreFocus: false });
    app.closeQuickSkillsPanel?.({ restoreFocus: false });
    app.updateAuthView("已退出，请重新登录。");
  };

  app.enterLogin = function enterLogin(message = "登录已过期，请重新登录。") {
    state.sessionToken = "";
    state.currentUser = null;
    localStorage.removeItem("echoSession");
    localStorage.removeItem("echoUser");
    if (state.codexTimer) {
      window.clearInterval(state.codexTimer);
      state.codexTimer = null;
    }
    app.closeCodexSessionStream?.();
    app.stopPairingScanner();
    app.closeSessionSidebar({ restoreFocus: false });
    app.closeQuickSkillsPanel?.({ restoreFocus: false });
    app.updateAuthView(message);
  };

  app.renderUserCenter = function renderUserCenter() {
    if (!app.isLoggedIn()) {
      elements.sidebarUserMeta.textContent = "请先登录，然后连接桌面端。";
      return;
    }
    elements.sidebarUserMeta.textContent = state.token
      ? "已连接桌面端，可以在这里刷新状态、重新配对或退出。"
      : "账号已登录，但还没有连接桌面端。";
  };

  app.setCurrentUser = function setCurrentUser(user, options = {}) {
    state.currentUser = user || null;
    if (state.currentUser) {
      localStorage.setItem("echoUser", JSON.stringify(state.currentUser));
    } else {
      localStorage.removeItem("echoUser");
    }
    if (options.updateView !== false) app.updateAuthView();
  };

  app.isLoggedIn = function isLoggedIn() {
    return !state.authEnabled || Boolean(state.sessionToken && state.currentUser);
  };

  app.displayUser = function displayUser(user) {
    return user?.displayName || user?.username || "";
  };

  app.showPairingPanel = function showPairingPanel({ focus = false } = {}) {
    if (!app.ensureLoggedIn()) return;
    app.updateAuthView();
    elements.pairingPanel.hidden = false;
    if (state.token && !elements.pairingStatus.textContent.trim()) {
      elements.pairingStatus.textContent = "重新扫码会覆盖当前桌面端配对。";
    }
    if (focus) {
      elements.pairingPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      elements.scanPairingButton.focus({ preventScroll: true });
    }
  };

  app.enterPairing = function enterPairing(message = "配对已失效，请重新扫描桌面端二维码。") {
    localStorage.removeItem("echoToken");
    state.token = "";
    if (state.codexTimer) {
      window.clearInterval(state.codexTimer);
      state.codexTimer = null;
    }
    app.closeCodexSessionStream?.();
    app.stopPairingScanner();
    app.closeQuickSkillsPanel?.({ restoreFocus: false });
    app.updateAuthView(message);
  };

  app.handleAuthError = function handleAuthError(error, message) {
    if (error.code === "SESSION_REQUIRED") {
      app.enterLogin("登录已过期，请重新登录。");
      return true;
    }
    if (error.code && error.code !== "PAIRING_REQUIRED") return false;
    if (error.status !== 401) return false;
    app.enterPairing(message);
    return true;
  };

  app.refreshStatus = async function refreshStatus(options = {}) {
    if (!app.isLoggedIn() || !state.token) {
      app.updateAuthView();
      return;
    }

    try {
      const status = await app.apiGet("/api/status");
      const codexOnline = status.codex?.agentOnline;
      app.setTopbarStatus(
        codexOnline ? "Codex 在线" : status.mode === "relay" ? "等待桌面 agent" : status.platform,
        codexOnline ? "online" : "idle"
      );
      if (status.user) app.setCurrentUser(status.user, { updateView: false });
      app.renderUserCenter();
      if (status.codex) app.renderCodexStatus(status.codex);
    } catch (error) {
      if (app.handleAuthError(error, "当前浏览器没有有效配对，请扫描桌面端二维码。")) {
        if (!options.silentAuthFailure) {
          elements.pairingStatus.textContent = "当前浏览器没有有效配对，请扫描桌面端二维码。";
        }
      } else {
        app.markCodexConnectionProblem?.("连接中断，当前会话已保留。") || app.setTopbarStatus("连接失败", "error");
        app.toast(error.message);
      }
    }
  };

  app.startPairingScanner = async function startPairingScanner() {
    if (!app.ensureLoggedIn()) return;
    app.showPairingPanel();
    if (!window.isSecureContext) {
      app.toast("扫码需要 HTTPS 或 localhost 安全上下文");
      return;
    }
    if (!("BarcodeDetector" in window)) {
      elements.pairingStatus.textContent = "当前浏览器不支持网页扫码，请使用 Android Chrome，或粘贴桌面端配对链接。";
      return;
    }

    try {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      state.pairingStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment"
        }
      });
      elements.pairingVideo.srcObject = state.pairingStream;
      await elements.pairingVideo.play();
      state.pairingScanActive = true;
      elements.pairingStatus.textContent = "正在扫描桌面端二维码...";
      elements.scanPairingButton.hidden = true;
      elements.stopScanButton.hidden = false;
      app.scanPairingFrame(detector);
    } catch (error) {
      app.stopPairingScanner();
      elements.pairingStatus.textContent = "相机没有启动，请检查浏览器相机权限，或粘贴配对链接。";
      app.toast(error.message);
    }
  };

  app.scanPairingFrame = async function scanPairingFrame(detector) {
    if (!state.pairingScanActive) return;
    if (!state.pairingScanBusy && elements.pairingVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      state.pairingScanBusy = true;
      try {
        const codes = await detector.detect(elements.pairingVideo);
        const value = codes[0]?.rawValue || "";
        const nextToken = app.extractPairingToken(value);
        if (nextToken) {
          await app.completePairing(nextToken);
          return;
        }
      } catch {
        // Ignore transient detector failures while the camera warms up.
      } finally {
        state.pairingScanBusy = false;
      }
    }
    window.requestAnimationFrame(() => app.scanPairingFrame(detector));
  };

  app.stopPairingScanner = function stopPairingScanner() {
    state.pairingScanActive = false;
    state.pairingScanBusy = false;
    if (state.pairingStream) {
      state.pairingStream.getTracks().forEach((track) => track.stop());
      state.pairingStream = null;
    }
    elements.pairingVideo.srcObject = null;
    elements.scanPairingButton.hidden = false;
    elements.stopScanButton.hidden = true;
    if (!state.token) {
      elements.pairingStatus.textContent ||= "如果你是直接打开这个网页，请先扫桌面端显示的二维码。";
    }
  };

  app.pairFromInput = async function pairFromInput() {
    const nextToken = app.extractPairingToken(elements.pairingInput.value);
    if (!nextToken) {
      elements.pairingStatus.textContent = "没有找到配对 token，请粘贴完整配对链接或 token。";
      return;
    }
    await app.completePairing(nextToken);
  };

  app.extractPairingToken = function extractPairingToken(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      const url = new URL(text, window.location.origin);
      const urlToken = url.searchParams.get("token") || "";
      if (urlToken) return urlToken;
    } catch {
      // Fall through to raw token handling.
    }
    return /^[A-Za-z0-9._-]{12,}$/.test(text) ? text : "";
  };

  app.completePairing = async function completePairing(nextToken) {
    if (!app.ensureLoggedIn()) return;
    state.token = nextToken;
    localStorage.setItem("echoToken", state.token);
    app.stopPairingScanner();
    elements.pairingInput.value = "";
    await app.bootAuthenticated();
    if (state.token) app.toast("配对成功");
  };
}
