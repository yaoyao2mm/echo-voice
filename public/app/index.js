import { installAuth } from "./auth.js?v=55";
import { installCodex } from "./codex.js?v=55";
import { createAppContext, installCore } from "./core.js?v=55";
import { installSessions } from "./sessions.js?v=55";

export function createApp(windowRef = window, documentRef = document) {
  const app = createAppContext(windowRef, documentRef);

  installCore(app);
  installAuth(app);
  installSessions(app);
  installCodex(app);

  app.bindEventListeners = function bindEventListeners() {
    const { elements } = app;

    elements.loginForm.addEventListener("submit", app.login);
    elements.logoutButton.addEventListener("click", app.logout);
    elements.openPairingButton.addEventListener("click", () => app.showPairingPanel({ focus: true }));
    elements.refreshStatus.addEventListener("click", app.refreshStatus);
    elements.scanPairingButton.addEventListener("click", app.startPairingScanner);
    elements.stopScanButton.addEventListener("click", app.stopPairingScanner);
    elements.savePairingButton.addEventListener("click", app.pairFromInput);
    elements.refreshCodex?.addEventListener("click", app.refreshCodex);
    elements.newCodexSessionButton.addEventListener("click", app.startNewCodexSession);
    elements.sendCodexButton.addEventListener("click", app.sendToCodex);
    elements.toggleSessionsButton.addEventListener("click", app.toggleSessionSidebar);
    elements.sessionBackdrop.addEventListener("click", app.closeSessionSidebar);
    elements.showActiveSessionsButton.addEventListener("click", () => app.setSessionArchiveView(false));
    elements.showArchivedSessionsButton.addEventListener("click", () => app.setSessionArchiveView(true));
    elements.codexRunSummary.addEventListener("click", app.handleConversationAction);
    elements.sidebarUserToggle.addEventListener("click", app.toggleSidebarUserMenu);
    elements.codexProject.addEventListener("change", () => {
      localStorage.setItem("echoCodexProject", elements.codexProject.value);
      app.syncProjectPicker();
      app.refreshActiveSessionHeader();
      app.updateComposerAvailability();
    });
    elements.codexPermissionMode.addEventListener("change", app.handleRuntimeControlChange);
    elements.codexModel.addEventListener("change", app.handleRuntimeControlChange);
    elements.codexReasoningEffort.addEventListener("change", app.handleRuntimeControlChange);
    elements.codexPrompt.addEventListener("input", () => {
      app.syncComposerInputHeight();
      app.updateComposerAvailability();
    });
    elements.composerAttachmentButton.addEventListener("click", app.openComposerAttachmentPicker);
    elements.composerAttachmentInput.addEventListener("change", app.handleComposerAttachmentInput);
    elements.codexPrompt.addEventListener("paste", app.handleComposerPaste);
    document.addEventListener("keydown", app.handleGlobalKeydown);
  };

  app.init = async function init() {
    app.bindViewportMetrics();
    app.bindTopbarScrollState();
    app.initRuntimeControls();
    app.bindEventListeners();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    app.renderComposerAttachments();
    app.syncComposerInputHeight();
    app.updateSessionSidebarToggle(false);

    await app.bootUserSession();
    app.updateAuthView();
    if (app.isLoggedIn() && app.state.token) {
      await app.bootAuthenticated();
    }
  };

  return app;
}
