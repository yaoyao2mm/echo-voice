import { installAuth } from "./auth.js?v=74";
import { installCodex } from "./codex.js?v=74";
import { createAppContext, installCore } from "./core.js?v=74";
import { installSessions } from "./sessions.js?v=74";

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
    elements.themeModeToggle?.addEventListener("change", app.toggleThemeMode);
    elements.worktreeModeToggle?.addEventListener("change", app.toggleWorktreeModePreference);
    elements.scanPairingButton.addEventListener("click", app.startPairingScanner);
    elements.stopScanButton.addEventListener("click", app.stopPairingScanner);
    elements.savePairingButton.addEventListener("click", app.pairFromInput);
    elements.refreshCodex?.addEventListener("click", app.refreshCodex);
    elements.newCodexSessionButton.addEventListener("click", app.startNewCodexSession);
    elements.sendCodexButton.addEventListener("click", app.sendToCodex);
    elements.stopCodexTurnButton?.addEventListener("click", app.cancelSelectedCodexTurn);
    elements.composerStatusText?.addEventListener("click", app.toggleTurnActivityDetails);
    elements.quickDeployButton?.addEventListener("click", app.sendQuickDeployPrompt);
    elements.composerPlanModeButton?.addEventListener("click", app.toggleComposerPlanMode);
    elements.compactContextButton?.addEventListener("click", () => app.requestContextCompaction({ automatic: false }));
    elements.toggleSessionsButton.addEventListener("click", app.toggleSessionSidebar);
    elements.sessionBackdrop.addEventListener("click", app.closeSessionSidebar);
    elements.projectSwitcherButton?.addEventListener("click", app.toggleProjectSwitcher);
    elements.newProjectButton?.addEventListener("click", app.toggleProjectCreateForm);
    elements.projectCreateForm?.addEventListener("submit", app.createProjectFromMobile);
    elements.showActiveSessionsButton.addEventListener("click", () => app.setSessionArchiveView(false));
    elements.showArchivedSessionsButton.addEventListener("click", () => app.setSessionArchiveView(true));
    elements.codexRunSummary.addEventListener("click", app.handleConversationAction);
    elements.sidebarUserToggle.addEventListener("click", app.toggleSidebarUserMenu);
    elements.codexProject.addEventListener("change", () => {
      app.selectProject(elements.codexProject.value).catch((error) => {
        if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
          app.toast(error.message);
        }
      });
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
    document.addEventListener("click", app.handleDocumentClick);
  };

  app.init = async function init() {
    app.applyThemeMode(app.state.themeMode, { persist: false });
    app.bindViewportMetrics();
    app.bindTopbarScrollState();
    app.initRuntimeControls();
    app.bindEventListeners();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    app.renderComposerAttachments();
    app.updateComposerModeControls?.();
    app.refreshWorktreeModeControls?.();
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
