export function installCodex(app) {
  const { constants, elements, state } = app;

  app.hasPendingComposerAttachments = function hasPendingComposerAttachments() {
    return Number(state.composerAttachmentPendingCount || 0) > 0;
  };

  app.setComposerAttachmentPendingCount = function setComposerAttachmentPendingCount(count) {
    state.composerAttachmentPendingCount = Math.max(0, Number(count) || 0);
    app.updateComposerAvailability();
  };

  app.refreshCodex = async function refreshCodex() {
    if (!app.isLoggedIn() || !state.token) return;

    try {
      const data = await app.apiGet("/api/codex/status");
      app.renderCodexStatus(data);
      await app.loadCodexJobs();
    } catch (error) {
      if (app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) return;
      elements.codexStatusText.textContent = "Codex 未连接";
      elements.codexQueueMeta.textContent = "";
      state.codexWorkspaces = [];
      state.codexAgentRuntime = {};
      app.refreshRuntimeDefaultOptions();
      elements.codexProject.innerHTML = "";
      app.renderProjectPicker(false);
      app.updateComposerAvailability();
      if (error.message && !error.message.includes("relay mode")) app.toast(error.message);
    }
  };

  app.renderCodexStatus = function renderCodexStatus(codex) {
    const workspaces = codex.workspaces || [];
    state.codexWorkspaces = workspaces;
    state.codexAgentRuntime = app.normalizeRuntimeChoice(codex.runtime || {});
    app.refreshRuntimeDefaultOptions();
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
    app.renderProjectPicker(codex.agentOnline);
    app.updateComposerAvailability();
    app.syncComposerMetrics();
  };

  app.openSessionSidebar = function openSessionSidebar() {
    elements.codexView.classList.add("sessions-open");
    app.setTopbarCollapsed(false);
    elements.sessionBackdrop.hidden = false;
    app.updateSessionSidebarToggle(true);
    app.syncBodySheetState();
  };

  app.closeSessionSidebar = function closeSessionSidebar({ restoreFocus = true } = {}) {
    elements.codexView.classList.remove("sessions-open");
    elements.sessionBackdrop.hidden = true;
    app.setSidebarUserMenuOpen(false);
    app.updateSessionSidebarToggle(false);
    app.syncBodySheetState();
    app.resetTopbarScrollTracking({ forceVisible: true });
    if (restoreFocus) {
      elements.toggleSessionsButton.focus({ preventScroll: true });
    }
  };

  app.toggleSessionSidebar = function toggleSessionSidebar() {
    if (elements.codexView.classList.contains("sessions-open")) {
      app.closeSessionSidebar();
      return;
    }
    app.openSessionSidebar();
  };

  app.updateSessionSidebarToggle = function updateSessionSidebarToggle(isOpen) {
    const label = isOpen ? "关闭会话列表" : "打开会话列表";
    elements.toggleSessionsButton.textContent = isOpen ? "✕" : "☰";
    elements.toggleSessionsButton.setAttribute("aria-label", label);
    elements.toggleSessionsButton.setAttribute("title", label);
    elements.toggleSessionsButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
  };

  app.syncBodySheetState = function syncBodySheetState() {
    document.body.classList.toggle("sheet-open", elements.codexView.classList.contains("sessions-open"));
  };

  app.toggleSidebarUserMenu = function toggleSidebarUserMenu() {
    app.setSidebarUserMenuOpen(elements.sidebarUserBody.hidden);
  };

  app.setSidebarUserMenuOpen = function setSidebarUserMenuOpen(isOpen) {
    elements.sidebarUserBody.hidden = !isOpen;
    elements.sidebarUserToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    elements.sidebarUserToggle.setAttribute("aria-label", isOpen ? "收起用户中心" : "展开用户中心");
    elements.sidebarUserToggle.setAttribute("title", isOpen ? "收起用户中心" : "展开用户中心");
  };

  app.setSessionArchiveView = async function setSessionArchiveView(archived) {
    if (state.showArchivedSessions === archived) return;
    state.showArchivedSessions = archived;
    elements.showActiveSessionsButton.classList.toggle("active", !archived);
    elements.showArchivedSessionsButton.classList.toggle("active", archived);
    state.composingNewSession = false;
    state.selectedCodexJobId = "";
    state.selectedCodexSession = null;
    app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
    app.renderEmptySessionDetail(
      archived
        ? { title: "归档", body: "归档会话只保留查看和恢复。" }
        : { title: "新会话", body: "选择权限、模型和推理强度后直接发送。" }
    );
    await app.loadCodexJobs();
  };

  app.startNewCodexSession = function startNewCodexSession() {
    state.selectedCodexJobId = "";
    state.selectedCodexSession = null;
    state.composingNewSession = true;
    app.clearComposerAttachments({ silent: true });
    app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
    if (state.showArchivedSessions) {
      state.showArchivedSessions = false;
      elements.showActiveSessionsButton.classList.add("active");
      elements.showArchivedSessionsButton.classList.remove("active");
      app.loadCodexJobs().catch(() => {});
    }
    app.closeSessionSidebar({ restoreFocus: false });
    app.renderEmptySessionDetail({
      title: "新会话",
      body: "选择权限、模型和推理强度后直接发送。"
    });
    app.resetTopbarScrollTracking({ forceVisible: true });
    for (const button of elements.codexJobs.querySelectorAll(".conversation-item")) {
      button.classList.remove("active");
    }
    app.updateComposerAvailability();
    elements.codexPrompt.focus({ preventScroll: true });
  };

  app.sendToCodex = async function sendToCodex() {
    if (!app.ensurePaired()) return;
    if (app.hasPendingComposerAttachments()) {
      app.toast("图片还在处理中，请稍候再发送");
      return;
    }

    const rawPrompt = elements.codexPrompt.value.trim();
    const attachments = app.currentComposerAttachmentsPayload();
    const projectId = elements.codexProject.value;
    const runtimeDraft = app.currentRuntimeDraft();
    const runtime = app.runtimeForAttachments(runtimeDraft, attachments);
    if (!rawPrompt && attachments.length === 0) {
      app.toast("请先填写任务或附上截图");
      return;
    }
    if (!projectId) {
      app.toast("桌面 agent 还没有公布项目");
      return;
    }

    localStorage.setItem("echoCodexProject", projectId);
    if (attachments.length > 0 && runtime.model !== runtimeDraft.model) {
      app.applyRuntimeDraft(runtime, { persist: true, dirty: true });
      app.toast("图片消息会自动使用桌面默认模型");
    }
    app.setComposerBusy(true, "发送中");
    try {
      const data = await app.sendCodexPrompt({ projectId, prompt: rawPrompt, runtime, attachments });
      if (state.showArchivedSessions) {
        state.showArchivedSessions = false;
        elements.showActiveSessionsButton.classList.add("active");
        elements.showArchivedSessionsButton.classList.remove("active");
      }
      state.selectedCodexJobId = data.session.id;
      state.selectedCodexSession = data.session;
      state.composingNewSession = false;
      state.runtimeDirty = false;
      app.applyRuntimeDraft(state.selectedCodexSession.runtime || runtime, { persist: false, dirty: false });
      elements.codexPrompt.value = "";
      app.syncComposerInputHeight();
      await app.loadCodexJobs();
      await app.showCodexJob(data.session.id);
      app.clearComposerAttachments({ silent: true });
      app.toast(attachments.length > 0 ? `已发送 ${attachments.length} 个附件` : "已发送");
      await app.refreshStatus({ silentAuthFailure: true });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    } finally {
      app.setComposerBusy(false);
    }
  };

  app.sendCodexPrompt = async function sendCodexPrompt({ projectId, prompt, runtime, attachments }) {
    if (app.canContinueSelectedSession()) {
      return app.apiPost(`/api/codex/sessions/${encodeURIComponent(state.selectedCodexJobId)}/messages`, {
        text: prompt,
        runtime,
        attachments
      });
    }
    if (!app.canStartNewSessionFromComposer()) {
      throw new Error("当前会话不能继续，请先从左上角新建会话。");
    }
    return app.apiPost("/api/codex/sessions", { projectId, prompt, runtime, attachments });
  };

  app.canContinueSelectedSession = function canContinueSelectedSession() {
    return app.sessionCanAcceptFollowUp(app.selectedSessionForComposer());
  };

  app.selectedSessionForComposer = function selectedSessionForComposer() {
    if (state.composingNewSession) return null;
    if (!state.selectedCodexJobId || !state.selectedCodexSession) return null;
    return state.selectedCodexSession;
  };

  app.sessionCanAcceptFollowUp = function sessionCanAcceptFollowUp(session) {
    if (!session || session.archivedAt) return false;
    if (session.status === "failed") return app.sessionCanRecoverFailure(session);
    return !["closed", "stale"].includes(session.status);
  };

  app.sessionCanRecoverFailure = function sessionCanRecoverFailure(session) {
    const error = String(session?.lastError || session?.error || "");
    return /thread not found|requires a newer version of Codex|Please upgrade to the latest app or CLI/i.test(error);
  };

  app.canStartNewSessionFromComposer = function canStartNewSessionFromComposer() {
    if (state.composingNewSession) return true;
    return !state.selectedCodexJobId && !state.selectedCodexSession;
  };

  app.selectedSessionNeedsExplicitNew = function selectedSessionNeedsExplicitNew() {
    if (state.composingNewSession) return false;
    if (!state.selectedCodexJobId || !state.selectedCodexSession) return false;
    return !app.canContinueSelectedSession();
  };

  app.sessionHasPendingWork = function sessionHasPendingWork(session) {
    if (!session) return false;
    return ["queued", "starting", "running"].includes(session.status) || Number(session.pendingCommandCount || 0) > 0;
  };

  app.composerActionLabel = function composerActionLabel() {
    if (app.selectedSessionNeedsExplicitNew()) return "先新建";
    if (!app.canContinueSelectedSession()) return "发送";
    return app.sessionHasPendingWork(state.selectedCodexSession) ? "继续排队" : "继续";
  };

  app.openComposerAttachmentPicker = function openComposerAttachmentPicker() {
    if (state.composerBusy || app.hasPendingComposerAttachments()) return;
    elements.composerAttachmentInput.click();
  };

  app.handleComposerAttachmentInput = async function handleComposerAttachmentInput(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (app.hasPendingComposerAttachments()) {
      if (files.length > 0) app.toast("请等待当前图片处理完成");
      return;
    }
    await app.addComposerAttachmentFiles(files);
  };

  app.handleComposerPaste = async function handleComposerPaste(event) {
    const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    if (app.hasPendingComposerAttachments()) {
      event.preventDefault();
      app.toast("请等待当前图片处理完成");
      return;
    }
    event.preventDefault();
    await app.addComposerAttachmentFiles(files);
  };

  app.addComposerAttachmentFiles = async function addComposerAttachmentFiles(files = []) {
    const imageFiles = files.filter((file) => file && file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      if (files.length) app.toast("只能附加图片");
      return;
    }

    const remaining = constants.MAX_COMPOSER_ATTACHMENTS - state.composerAttachments.length - state.composerAttachmentPendingCount;
    if (remaining <= 0) {
      app.toast(`最多附加 ${constants.MAX_COMPOSER_ATTACHMENTS} 张截图`);
      return;
    }
    if (imageFiles.length > remaining) {
      app.toast(`最多附加 ${constants.MAX_COMPOSER_ATTACHMENTS} 张截图`);
    }

    const accepted = [];
    const queuedFiles = imageFiles.slice(0, remaining);
    app.setComposerAttachmentPendingCount(state.composerAttachmentPendingCount + queuedFiles.length);
    for (const file of queuedFiles) {
      try {
        if (file.size > constants.MAX_COMPOSER_ATTACHMENT_BYTES) {
          app.toast(`截图不能超过 ${Math.round(constants.MAX_COMPOSER_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
          continue;
        }
        const url = await app.fileToDataUrl(file);
        accepted.push({
          id: crypto.randomUUID(),
          name: file.name || "截图",
          mimeType: file.type || "image/png",
          sizeBytes: file.size || 0,
          url
        });
      } catch {
        app.toast("读取截图失败，请重试");
      } finally {
        app.setComposerAttachmentPendingCount(state.composerAttachmentPendingCount - 1);
      }
    }

    if (accepted.length === 0) return;
    state.composerAttachments = [...state.composerAttachments, ...accepted].slice(0, constants.MAX_COMPOSER_ATTACHMENTS);
    app.renderComposerAttachments();
  };

  app.fileToDataUrl = function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("file read failed"));
      reader.readAsDataURL(file);
    });
  };

  app.renderComposerAttachments = function renderComposerAttachments() {
    const hasAttachments = state.composerAttachments.length > 0;
    elements.composerAttachmentTray.hidden = !hasAttachments;
    elements.composerAttachmentButton.classList.toggle("active", hasAttachments);
    elements.composerAttachmentButton.setAttribute(
      "aria-label",
      hasAttachments ? `已附加 ${state.composerAttachments.length} 张截图` : "附加截图"
    );
    elements.composerAttachmentTray.innerHTML = hasAttachments
      ? `
          ${state.composerAttachments
            .map((attachment, index) => {
              const label = app.attachmentDisplayLabel(attachment, index);
              return `
                <div class="composer-attachment-pill" data-attachment-id="${app.escapeHtml(attachment.id)}">
                  <span class="composer-attachment-pill-label">${app.escapeHtml(label)}</span>
                  <button type="button" class="composer-attachment-remove" aria-label="移除 ${app.escapeHtml(label)}">移除</button>
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
        app.removeComposerAttachment(chip.dataset.attachmentId || "");
      });
    }

    app.updateComposerAvailability();
  };

  app.removeComposerAttachment = function removeComposerAttachment(id) {
    state.composerAttachments = state.composerAttachments.filter((attachment) => attachment.id !== id);
    app.renderComposerAttachments();
  };

  app.clearComposerAttachments = function clearComposerAttachments(options = {}) {
    if (state.composerAttachments.length === 0 && options.silent) return;
    state.composerAttachments = [];
    app.renderComposerAttachments();
  };

  app.currentComposerAttachmentsPayload = function currentComposerAttachmentsPayload() {
    return state.composerAttachments.map((attachment) => ({
      type: "image",
      url: attachment.url,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes
    }));
  };

  app.setComposerBusy = function setComposerBusy(isBusy, label = "") {
    state.composerBusy = isBusy;
    if (label) app.setTopbarStatus(label, isBusy ? "busy" : "info");
    elements.sendCodexButton.textContent = isBusy ? label || "处理中" : app.composerActionLabel();
    app.updateComposerAvailability();
    app.syncComposerMetrics();
    app.refreshComposerStatusBar();
    if (!isBusy) app.refreshStatus({ silentAuthFailure: true });
  };

  app.updateComposerAvailability = function updateComposerAvailability() {
    const hasProject = Boolean(elements.codexProject.value);
    const hasDraft = Boolean(elements.codexPrompt.value.trim()) || state.composerAttachments.length > 0;
    const blockedBySelectedSession = app.selectedSessionNeedsExplicitNew();
    const attachmentsPending = app.hasPendingComposerAttachments();
    elements.sendCodexButton.disabled = state.composerBusy || attachmentsPending || !hasProject || !hasDraft || blockedBySelectedSession;
    if (!state.composerBusy) {
      elements.sendCodexButton.textContent = attachmentsPending ? "处理图片" : app.composerActionLabel();
    }
    elements.newCodexSessionButton.disabled = state.composerBusy;
    elements.codexProject.disabled = state.composerBusy;
    elements.codexPermissionMode.disabled = state.composerBusy;
    elements.codexModel.disabled = state.composerBusy;
    elements.codexReasoningEffort.disabled = state.composerBusy;
    elements.codexPrompt.disabled = state.composerBusy;
    elements.composerAttachmentButton.disabled = state.composerBusy || attachmentsPending;
    app.refreshComposerMeta();
    app.refreshTopbarProjectChip();
    app.syncComposerMetrics();
    app.refreshComposerStatusBar();
  };

  app.renderProjectPicker = function renderProjectPicker(agentOnline) {
    const selectedWorkspace = state.codexWorkspaces.find((workspace) => workspace.id === elements.codexProject.value) || null;
    const hasProjects = state.codexWorkspaces.length > 0;
    elements.projectSidebarCard.classList.toggle("empty", !selectedWorkspace);

    if (!hasProjects) {
      elements.projectPickerLabel.textContent = agentOnline ? "还没有授权工程目录" : "等待桌面 agent";
      elements.projectPickerMeta.textContent = agentOnline
        ? "去桌面端 Codex 设置添加允许的项目。"
        : "桌面端启动后会同步可切换项目。";
      elements.composerProjectLabel.textContent = elements.projectPickerLabel.textContent;
      elements.projectSheetStatus.textContent = "";
      app.renderProjectSheetList();
      app.refreshActiveSessionHeader();
      app.refreshTopbarProjectChip();
      return;
    }

    if (selectedWorkspace) {
      elements.projectPickerLabel.textContent = app.workspaceLabel(selectedWorkspace);
      elements.projectPickerMeta.textContent = app.workspaceMeta(selectedWorkspace);
      elements.composerProjectLabel.textContent = app.workspaceLabel(selectedWorkspace);
    } else {
      elements.projectPickerLabel.textContent = "选择项目";
      elements.projectPickerMeta.textContent = `已同步 ${state.codexWorkspaces.length} 个项目。`;
      elements.composerProjectLabel.textContent = elements.projectPickerLabel.textContent;
    }

    elements.projectSheetStatus.textContent = "";
    app.renderProjectSheetList();
    app.refreshActiveSessionHeader();
    app.refreshTopbarProjectChip();
  };

  app.renderProjectSheetList = function renderProjectSheetList() {
    elements.projectSheetList.innerHTML = "";
    if (!state.codexWorkspaces.length) {
      elements.projectSheetList.innerHTML = '<div class="project-sheet-empty">暂时没有可切换工程。</div>';
      return;
    }

    for (const workspace of state.codexWorkspaces) {
      const button = document.createElement("button");
      const isActive = workspace.id === elements.codexProject.value;
      const secondaryLabel = app.workspaceSecondaryLabel(workspace);
      const pathLabel = app.workspacePathLabel(workspace) || app.workspaceMeta(workspace);
      button.type = "button";
      button.className = "project-option";
      button.dataset.projectId = workspace.id || "";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", isActive ? "true" : "false");
      button.classList.toggle("active", isActive);
      button.innerHTML = `
        <div class="project-option-main">
          <div class="project-option-title-row">
            <strong>${app.escapeHtml(app.workspaceLabel(workspace))}</strong>
            ${isActive ? '<span class="project-option-badge">当前</span>' : ""}
          </div>
          ${secondaryLabel ? `<span class="project-option-id">${app.escapeHtml(secondaryLabel)}</span>` : ""}
          <span class="project-option-path">${app.escapeHtml(pathLabel)}</span>
        </div>
      `;
      button.addEventListener("click", () => app.selectProject(workspace.id));
      elements.projectSheetList.append(button);
    }
  };

  app.handleGlobalKeydown = function handleGlobalKeydown(event) {
    if (event.key !== "Escape") return;
    if (elements.codexView.classList.contains("sessions-open")) {
      event.preventDefault();
      app.closeSessionSidebar();
    }
  };

  app.selectProject = function selectProject(projectId) {
    if (!projectId) return;
    const previous = elements.codexProject.value;
    elements.codexProject.value = projectId;
    localStorage.setItem("echoCodexProject", projectId);
    app.syncProjectPicker();
    app.updateComposerAvailability();
    if (previous && previous !== projectId) {
      app.toast(`已切换到 ${app.workspaceLabel(state.codexWorkspaces.find((workspace) => workspace.id === projectId) || { id: projectId })}`);
    }
  };

  app.syncProjectPicker = function syncProjectPicker() {
    const workspace = state.codexWorkspaces.find((item) => item.id === elements.codexProject.value);
    if (workspace) {
      elements.projectPickerLabel.textContent = app.workspaceLabel(workspace);
      elements.projectPickerMeta.textContent = app.workspaceMeta(workspace);
      elements.composerProjectLabel.textContent = app.workspaceLabel(workspace);
    } else {
      elements.composerProjectLabel.textContent = elements.projectPickerLabel.textContent;
    }
    elements.projectSidebarCard.classList.toggle("empty", !workspace);
    app.refreshTopbarProjectChip();
    app.renderProjectSheetList();
    app.refreshActiveSessionHeader();
  };
}
