const CODEX_AGENT_STATUS_GRACE_MS = 2 * 60 * 1000;

export function installCodex(app) {
  const { constants, elements, state } = app;

  app.hasPendingComposerAttachments = function hasPendingComposerAttachments() {
    return Number(state.composerAttachmentPendingCount || 0) > 0;
  };

  app.setComposerAttachmentPendingCount = function setComposerAttachmentPendingCount(count) {
    state.composerAttachmentPendingCount = Math.max(0, Number(count) || 0);
    app.updateComposerAvailability();
  };

  app.refreshCodex = async function refreshCodex(options = {}) {
    if (!app.isLoggedIn() || !state.token) return;
    if (state.codexRefreshPromise) return state.codexRefreshPromise;

    state.codexRefreshPromise = (async () => {
      try {
        const data = await app.apiGet("/api/codex/status");
        app.renderCodexStatus(data);
        const shouldLoadQuickSkills =
          options.forceQuickSkills || !options.scheduled || state.quickSkillsLoadedProjectId !== app.currentProjectId();
        if (shouldLoadQuickSkills) await app.loadQuickSkills({ silent: true });
        await app.loadCodexJobs({ skipSelectedDetailLoad: Boolean(state.sessionEventSourceId || state.sessionEventReconnectTimer) });
      } catch (error) {
        if (app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) return;
        const shouldToast = app.markCodexConnectionProblem("连接中断，当前会话已保留。");
        if (shouldToast && error.message && !error.message.includes("relay mode")) app.toast(error.message);
      }
    })().finally(() => {
      state.codexRefreshPromise = null;
    });

    return state.codexRefreshPromise;
  };

  app.renderCodexStatus = function renderCodexStatus(codex) {
    const agentOnline = Boolean(codex.agentOnline);
    const agentAvailable = agentOnline || app.codexAgentRecentlySeen(codex);
    const agentStatusText = agentOnline ? "Codex 在线" : agentAvailable ? "桌面状态同步中" : "等待桌面 agent";
    const workspaces = app.codexWorkspacesForStatus(codex);
    const previousProject = app.currentProjectId();
    state.codexWorkspaces = workspaces;
    state.codexAgentOnline = agentOnline;
    state.codexAgentAvailable = agentAvailable;
    state.codexLastAgentSeenAt = app.codexLastAgentSeenAt(codex);
    state.codexConnectionState = agentOnline ? "online" : agentAvailable ? "syncing" : "waiting";
    state.codexUnsupportedModels = Array.isArray(codex.runtime?.unsupportedModels)
      ? codex.runtime.unsupportedModels.map((model) => String(model || "").trim()).filter(Boolean)
      : [];
    state.codexSupportedModels = Array.isArray(codex.runtime?.supportedModels)
      ? codex.runtime.supportedModels
          .map((model) => ({
            id: String(model?.id || model?.model || "").trim(),
            displayName: String(model?.displayName || model?.display_name || model?.id || model?.model || "").trim()
          }))
          .filter((model) => model.id)
      : [];
    state.codexAllowedPermissionModes = Array.isArray(codex.runtime?.allowedPermissionModes)
      ? codex.runtime.allowedPermissionModes.map((mode) => app.normalizePermissionMode(mode)).filter(Boolean)
      : [];
    state.codexAgentRuntime = app.normalizeRuntimeChoice(codex.runtime || {});
    app.applyRuntimeDraft(app.runtimeChoiceWithFallback(app.currentRuntimeDraft(), state.runtimePreferences), {
      persist: false,
      dirty: state.runtimeDirty
    });
    app.refreshRuntimeDefaultOptions();
    app.refreshWorktreeModeControls?.();
    app.setTopbarStatus(agentStatusText, agentOnline ? "online" : "idle");
    elements.codexStatusText.textContent = agentOnline ? "本机 Codex 在线" : agentStatusText;
    const pendingDecisions = Number(codex.interactive?.pendingInteractions || 0) + Number(codex.interactive?.pendingApprovals || 0);
    elements.codexQueueMeta.textContent = agentAvailable
      ? `会话 ${codex.interactive?.activeSessions || 0} · 待处理 ${pendingDecisions} · 归档 ${codex.interactive?.archivedSessions || 0} · 项目 ${workspaces.length}`
      : workspaces.length
        ? `桌面离线 · 可浏览已同步会话 · 项目 ${workspaces.length}`
        : "打开桌面端后自动同步";

    const preferred = localStorage.getItem("echoCodexProject") || previousProject || elements.codexProject.value;
    const selected =
      workspaces.find((workspace) => workspace.id === preferred)?.id ||
      (agentAvailable ? workspaces[0]?.id : workspaces.find((workspace) => workspace.id === previousProject)?.id || workspaces[0]?.id) ||
      "";
    if (previousProject && selected && previousProject !== selected && agentOnline) {
      state.composingNewSession = false;
      state.selectedCodexJobId = "";
      state.selectedCodexSession = null;
      app.closeCodexSessionStream?.();
    }
    app.renderCodexProjectOptions(workspaces, selected, agentAvailable);
    if (elements.codexProject.value) localStorage.setItem("echoCodexProject", elements.codexProject.value);
    if (agentOnline && workspaces.length > 0) app.persistCodexWorkspaces(workspaces);
    app.renderProjectPicker(agentAvailable);
    app.updateComposerAvailability();
    app.syncComposerMetrics();
  };

  app.codexLastAgentSeenAt = function codexLastAgentSeenAt(codex = {}) {
    const direct = String(codex.lastAgentSeenAt || "").trim();
    if (direct) return direct;
    const agents = Array.isArray(codex.agents) ? codex.agents : [];
    return String(agents[0]?.lastSeenAt || "").trim();
  };

  app.codexAgentRecentlySeen = function codexAgentRecentlySeen(codex = {}) {
    const lastSeenMs = new Date(app.codexLastAgentSeenAt(codex)).getTime();
    return Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs < CODEX_AGENT_STATUS_GRACE_MS;
  };

  app.codexWorkspacesForStatus = function codexWorkspacesForStatus(codex = {}) {
    const incoming = Array.isArray(codex.workspaces)
      ? codex.workspaces.map(app.normalizeCodexWorkspace).filter(Boolean)
      : [];
    if (incoming.length > 0 || codex.agentOnline) return incoming;

    const projectId = app.currentProjectId();
    const cached = (state.codexWorkspaces || []).map(app.normalizeCodexWorkspace).filter(Boolean);
    if (!projectId) return cached;
    return app.mergeCodexWorkspaces(cached, [app.cachedWorkspaceForProject(projectId)]);
  };

  app.normalizeCodexWorkspace = function normalizeCodexWorkspace(workspace = {}) {
    const source = workspace && typeof workspace === "object" ? workspace : {};
    const id = String(source.id || "").trim();
    if (!id) return null;
    return {
      id,
      label: String(source.label || source.id || source.path || "").trim() || id,
      path: String(source.path || "").trim()
    };
  };

  app.mergeCodexWorkspaces = function mergeCodexWorkspaces(...groups) {
    const byId = new Map();
    for (const group of groups) {
      for (const workspace of group || []) {
        const normalized = app.normalizeCodexWorkspace(workspace);
        if (!normalized || byId.has(normalized.id)) continue;
        byId.set(normalized.id, normalized);
      }
    }
    return Array.from(byId.values()).slice(0, 50);
  };

  app.cachedWorkspaceForProject = function cachedWorkspaceForProject(projectId) {
    const id = String(projectId || "").trim();
    if (!id) return null;
    return (
      app.normalizeCodexWorkspace((state.codexWorkspaces || []).find((workspace) => workspace.id === id)) || {
        id,
        label: id,
        path: ""
      }
    );
  };

  app.persistCodexWorkspaces = function persistCodexWorkspaces(workspaces = []) {
    const normalized = app.mergeCodexWorkspaces(workspaces);
    if (normalized.length === 0) return;
    localStorage.setItem("echoCodexWorkspaces", JSON.stringify(normalized));
  };

  app.renderCodexProjectOptions = function renderCodexProjectOptions(workspaces, selected, agentOnline) {
    elements.codexProject.innerHTML = "";
    if (!workspaces.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = agentOnline ? "还没有授权工程目录" : "等待桌面 agent";
      elements.codexProject.append(option);
      return;
    }
    for (const workspace of workspaces) {
      const option = document.createElement("option");
      option.value = workspace.id;
      option.textContent = workspace.label || workspace.id || workspace.path;
      option.title = workspace.path || "";
      option.selected = workspace.id === selected;
      elements.codexProject.append(option);
    }
    if (selected && workspaces.some((workspace) => workspace.id === selected)) {
      elements.codexProject.value = selected;
    }
  };

  app.markCodexConnectionProblem = function markCodexConnectionProblem(message = "连接中断，当前会话已保留。") {
    const wasAlreadyError = state.codexConnectionState === "error";
    state.codexConnectionState = "error";
    state.codexAgentOnline = false;
    state.codexAgentAvailable = false;
    const projectId = app.currentProjectId() || state.codexWorkspaces?.[0]?.id || "";
    if (projectId) {
      state.codexWorkspaces = app.mergeCodexWorkspaces(state.codexWorkspaces, [app.cachedWorkspaceForProject(projectId)]);
      app.renderCodexProjectOptions(state.codexWorkspaces, projectId, false);
    } else if (state.codexWorkspaces?.length) {
      app.renderCodexProjectOptions(state.codexWorkspaces, state.codexWorkspaces[0]?.id || "", false);
    }
    if (elements.codexProject.value) localStorage.setItem("echoCodexProject", elements.codexProject.value);
    app.setTopbarStatus("连接中断", "error");
    elements.codexStatusText.textContent = "连接中断";
    elements.codexQueueMeta.textContent = message;
    app.renderProjectPicker(false);
    app.updateComposerAvailability();
    return !wasAlreadyError;
  };

  app.openSessionSidebar = function openSessionSidebar() {
    app.closeFileBrowser?.({ restoreFocus: false });
    elements.codexView.classList.add("sessions-open");
    app.setTopbarCollapsed(false);
    elements.sessionBackdrop.hidden = false;
    elements.sessionBackdrop.dataset.layer = "sessions";
    elements.sessionBackdrop.setAttribute("aria-label", "关闭会话列表");
    app.updateSessionSidebarToggle(true);
    app.syncBodySheetState();
  };

  app.closeSessionSidebar = function closeSessionSidebar({ restoreFocus = true } = {}) {
    elements.codexView.classList.remove("sessions-open");
    elements.sessionBackdrop.hidden = true;
    delete elements.sessionBackdrop.dataset.layer;
    app.closeProjectSwitcher?.();
    app.setSidebarUserMenuOpen(false);
    app.updateSessionSidebarToggle(false);
    app.syncBodySheetState();
    app.resetTopbarScrollTracking({ forceVisible: true });
    if (restoreFocus) {
      elements.toggleSessionsButton.focus({ preventScroll: true });
    }
  };

  app.openProjectSwitcher = function openProjectSwitcher() {
    app.closeQuickSkillsPanel?.();
    app.setTopbarCollapsed(false);
    app.renderProjectSheetList();
    app.updateProjectCreateControls();
  };

  app.closeProjectSwitcher = function closeProjectSwitcher() {
    if (!state.projectCreateBusy && elements.projectCreateForm) {
      elements.projectCreateForm.hidden = true;
      if (elements.projectSheetStatus) elements.projectSheetStatus.textContent = "";
    }
  };

  app.toggleProjectSwitcher = function toggleProjectSwitcher(event) {
    event?.stopPropagation();
    app.openProjectSwitcher();
  };

  app.handleDocumentClick = function handleDocumentClick(event) {
    if (elements.quickSkills && !elements.quickSkillsPanel?.hidden && !elements.quickSkills.contains(event.target)) {
      app.closeQuickSkillsPanel();
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
    app.closeCodexSessionStream?.();
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
    app.closeCodexSessionStream?.();
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
    if (state.composerBusy) return;
    if (!app.ensurePaired()) return;
    if (app.hasPendingComposerAttachments()) {
      app.toast("图片还在处理中，请稍候再发送");
      return;
    }

    const rawPrompt = elements.codexPrompt.value.trim();
    const attachments = app.currentComposerAttachmentsPayload();
    const projectId = app.currentProjectId();
    const runtimeDraft = app.currentRuntimeDraft();
    const runtime = app.runtimeForAttachments(runtimeDraft, attachments);
    const mode = state.composerPlanMode ? "plan" : "execute";
    if (!rawPrompt && attachments.length === 0) {
      app.toast("请先填写任务或附上截图");
      return;
    }
    if (!projectId) {
      app.toast("桌面 agent 还没有公布项目");
      return;
    }
    if (!app.codexCommandsAvailable()) {
      app.toast(state.codexConnectionState === "error" ? "连接恢复后再发送" : "桌面 agent 在线后再发送");
      return;
    }

    localStorage.setItem("echoCodexProject", projectId);
    if (attachments.length > 0 && runtime.model !== runtimeDraft.model) {
      app.applyRuntimeDraft(runtime, { persist: true, dirty: true });
      app.toast("图片消息会自动使用桌面默认模型");
    }
    app.setComposerBusy(true, "发送中");
    try {
      const data = await app.sendCodexPrompt({ projectId, prompt: rawPrompt, runtime, attachments, mode });
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
      app.renderCodexJob(data.session, { keepSelection: true, scrollToBottom: true });
      elements.codexPrompt.value = "";
      app.syncComposerInputHeight();
      app.clearComposerAttachments({ silent: true });
      await app.showCodexJob(data.session.id, { keepSelection: true, scrollToBottom: true });
      app.scheduleSessionListRefresh?.({ delayMs: 300 });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    } finally {
      app.setComposerBusy(false);
    }
  };

  app.loadQuickSkills = async function loadQuickSkills({ silent = false } = {}) {
    if (!app.isLoggedIn() || !state.token) return;
    const projectId = app.currentProjectId();
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);

    try {
      const data = await app.apiGet(`/api/codex/quick-skills?${params.toString()}`);
      state.quickSkills = Array.isArray(data.items) ? data.items.map(app.normalizeQuickSkill).filter(Boolean) : [];
      state.quickSkillsLoadedProjectId = projectId;
      app.renderQuickSkills();
      app.updateComposerAvailability();
    } catch (error) {
      if (!silent && !app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
    }
  };

  app.normalizeQuickSkill = function normalizeQuickSkill(skill = {}) {
    const id = String(skill.id || "").trim();
    const title = String(skill.title || "").trim();
    const prompt = String(skill.prompt || "").trim();
    if (!id || !title || !prompt) return null;
    return {
      id,
      scope: skill.scope === "global" ? "global" : "project",
      projectId: String(skill.projectId || "").trim(),
      title: title.slice(0, 80),
      description: String(skill.description || "").trim().slice(0, 240),
      prompt: prompt.slice(0, 12000),
      mode: skill.mode === "plan" ? "plan" : "execute",
      requiresSession: Boolean(skill.requiresSession),
      sortOrder: Number(skill.sortOrder || 0),
      createdAt: String(skill.createdAt || ""),
      updatedAt: String(skill.updatedAt || "")
    };
  };

  app.toggleQuickSkillsPanel = async function toggleQuickSkillsPanel(event) {
    event?.stopPropagation();
    if (!elements.quickSkillsPanel) return;
    if (elements.quickSkillsPanel.hidden) {
      await app.openQuickSkillsPanel();
      return;
    }
    app.closeQuickSkillsPanel({ restoreFocus: true });
  };

  app.openQuickSkillsPanel = async function openQuickSkillsPanel() {
    if (!elements.quickSkillsPanel) return;
    app.closeProjectSwitcher();
    app.setTopbarCollapsed(false);
    elements.quickSkillsPanel.hidden = false;
    elements.quickSkillsButton?.setAttribute("aria-expanded", "true");
    if (state.quickSkillsLoadedProjectId !== app.currentProjectId()) await app.loadQuickSkills({ silent: true });
    app.renderQuickSkills();
  };

  app.closeQuickSkillsPanel = function closeQuickSkillsPanel({ restoreFocus = false } = {}) {
    if (!elements.quickSkillsPanel || elements.quickSkillsPanel.hidden) return;
    elements.quickSkillsPanel.hidden = true;
    elements.quickSkillsButton?.setAttribute("aria-expanded", "false");
    app.resetQuickSkillForm();
    if (restoreFocus) elements.quickSkillsButton?.focus({ preventScroll: true });
  };

  app.renderQuickSkills = function renderQuickSkills() {
    if (!elements.quickSkillsList) return;
    const projectId = app.currentProjectId();
    const projectLabel = projectId ? app.sessionProjectLabel(projectId) : "未选择工程";
    const globalSkills = state.quickSkills.filter((skill) => skill.scope === "global");
    const projectSkills = state.quickSkills.filter((skill) => skill.scope === "project");
    if (elements.quickSkillsMeta) {
      elements.quickSkillsMeta.textContent = `${globalSkills.length} 个全局 · ${projectSkills.length} 个项目`;
    }

    elements.quickSkillsList.innerHTML = "";
    if (state.quickSkills.length === 0) {
      elements.quickSkillsList.innerHTML = '<div class="quick-skills-empty">还没有快速指令。</div>';
      return;
    }

    const groups = [
      { title: "全局", meta: "所有项目可用", items: globalSkills },
      { title: "项目", meta: projectLabel, items: projectSkills }
    ];
    for (const group of groups) {
      const section = document.createElement("section");
      section.className = "quick-skill-group";
      section.innerHTML = `
        <div class="quick-skill-group-head">
          <strong>${app.escapeHtml(group.title)}</strong>
          <span>${app.escapeHtml(group.meta)}</span>
        </div>
      `;
      const wheel = document.createElement("div");
      wheel.className = "quick-skill-wheel";
      if (group.items.length === 0) {
        wheel.innerHTML = '<div class="quick-skills-empty compact">暂无</div>';
      } else {
        for (const skill of group.items) {
          wheel.append(app.renderQuickSkillButton(skill));
        }
      }
      section.append(wheel);
      elements.quickSkillsList.append(section);
    }
  };

  app.renderQuickSkillButton = function renderQuickSkillButton(skill) {
    const item = document.createElement("div");
    item.className = "quick-skill-item";
    item.dataset.skillId = skill.id;
    item.innerHTML = `
      <button class="quick-skill-run" type="button">
        <span class="quick-skill-chamber" aria-hidden="true"></span>
        <span class="quick-skill-copy">
          <strong>${app.escapeHtml(skill.title)}</strong>
          <span>${app.escapeHtml(skill.description || (skill.mode === "plan" ? "计划模式" : "执行模式"))}</span>
        </span>
      </button>
      <button class="quick-skill-edit" type="button" aria-label="编辑 ${app.escapeHtml(skill.title)}" title="编辑">编辑</button>
    `;
    item.querySelector(".quick-skill-run").addEventListener("click", () => app.sendQuickSkill(skill));
    item.querySelector(".quick-skill-edit").addEventListener("click", () => app.editQuickSkill(skill.id));
    return item;
  };

  app.sendQuickSkill = async function sendQuickSkill(skill) {
    if (state.composerBusy) return;
    if (!app.ensurePaired()) return;
    if (app.hasPendingComposerAttachments()) {
      app.toast("图片还在处理中，请稍候再发送");
      return;
    }
    if (elements.codexPrompt.value.trim() || state.composerAttachments.length > 0) {
      app.toast("请先发送或清空输入框内容");
      return;
    }

    const projectId = app.currentProjectId();
    const session = app.selectedSessionForComposer();
    if (!projectId) {
      app.toast("桌面 agent 还没有公布项目");
      return;
    }
    if (!app.codexCommandsAvailable()) {
      app.toast(state.codexConnectionState === "error" ? "连接恢复后再发送" : "桌面 agent 在线后再发送");
      return;
    }
    if (skill.requiresSession && !session) {
      app.toast("先打开要使用的对话");
      return;
    }
    if (skill.requiresSession && !app.canRunSessionQuickSkill()) {
      app.toast("当前会话暂时不能使用这个指令");
      return;
    }

    localStorage.setItem("echoCodexProject", projectId);
    app.closeQuickSkillsPanel();
    app.setComposerBusy(true, "发送中");
    try {
      const runtime = app.currentRuntimeDraft();
      const data = await app.sendCodexPrompt({ projectId, prompt: skill.prompt, runtime, attachments: [], mode: skill.mode });
      state.selectedCodexJobId = data.session.id;
      state.selectedCodexSession = data.session;
      state.composingNewSession = false;
      state.runtimeDirty = false;
      app.applyRuntimeDraft(state.selectedCodexSession.runtime || runtime, { persist: false, dirty: false });
      app.renderCodexJob(data.session, { keepSelection: true, scrollToBottom: true });
      await app.showCodexJob(data.session.id, { keepSelection: true, scrollToBottom: true });
      app.scheduleSessionListRefresh?.({ delayMs: 300 });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    } finally {
      app.setComposerBusy(false);
    }
  };

  app.startNewQuickSkill = function startNewQuickSkill() {
    app.fillQuickSkillForm({
      id: "",
      scope: app.currentProjectId() ? "project" : "global",
      projectId: app.currentProjectId(),
      title: "",
      description: "",
      prompt: "",
      mode: state.composerPlanMode ? "plan" : "execute",
      requiresSession: false
    });
  };

  app.editQuickSkill = function editQuickSkill(id) {
    const skill = state.quickSkills.find((item) => item.id === id);
    if (!skill) return;
    app.fillQuickSkillForm(skill);
  };

  app.fillQuickSkillForm = function fillQuickSkillForm(skill) {
    state.quickSkillEditingId = skill.id || "";
    elements.quickSkillForm.hidden = false;
    elements.quickSkillId.value = skill.id || "";
    elements.quickSkillTitle.value = skill.title || "";
    elements.quickSkillScope.value = skill.scope === "global" ? "global" : "project";
    elements.quickSkillMode.value = skill.mode === "plan" ? "plan" : "execute";
    elements.quickSkillRequiresSession.checked = Boolean(skill.requiresSession);
    elements.quickSkillDescription.value = skill.description || "";
    elements.quickSkillPrompt.value = skill.prompt || "";
    elements.quickSkillDeleteButton.hidden = !skill.id;
    elements.quickSkillSaveButton.textContent = skill.id ? "保存" : "创建";
    app.updateQuickSkillFormControls();
    elements.quickSkillTitle.focus({ preventScroll: true });
  };

  app.resetQuickSkillForm = function resetQuickSkillForm() {
    if (!elements.quickSkillForm) return;
    state.quickSkillEditingId = "";
    elements.quickSkillForm.hidden = true;
    elements.quickSkillId.value = "";
    elements.quickSkillTitle.value = "";
    elements.quickSkillScope.value = app.currentProjectId() ? "project" : "global";
    elements.quickSkillMode.value = "execute";
    elements.quickSkillRequiresSession.checked = false;
    elements.quickSkillDescription.value = "";
    elements.quickSkillPrompt.value = "";
    elements.quickSkillDeleteButton.hidden = true;
    app.updateQuickSkillFormControls();
  };

  app.updateQuickSkillFormControls = function updateQuickSkillFormControls() {
    if (!elements.quickSkillForm) return;
    const disabled = state.quickSkillsBusy;
    for (const control of [
      elements.quickSkillTitle,
      elements.quickSkillScope,
      elements.quickSkillMode,
      elements.quickSkillRequiresSession,
      elements.quickSkillDescription,
      elements.quickSkillPrompt,
      elements.quickSkillDeleteButton,
      elements.quickSkillCancelButton,
      elements.quickSkillSaveButton
    ]) {
      if (control) control.disabled = disabled;
    }
    if (elements.quickSkillScope && !app.currentProjectId() && elements.quickSkillScope.value === "project") {
      elements.quickSkillScope.value = "global";
    }
    if (elements.quickSkillScope) {
      for (const option of Array.from(elements.quickSkillScope.options || [])) {
        if (option.value === "project") option.disabled = !app.currentProjectId();
      }
    }
  };

  app.saveQuickSkill = async function saveQuickSkill(event) {
    event?.preventDefault();
    if (!app.ensurePaired()) return;
    const id = elements.quickSkillId.value.trim();
    const scope = elements.quickSkillScope.value === "global" ? "global" : "project";
    const body = {
      scope,
      projectId: scope === "project" ? app.currentProjectId() : "",
      title: elements.quickSkillTitle.value.trim(),
      description: elements.quickSkillDescription.value.trim(),
      prompt: elements.quickSkillPrompt.value.trim(),
      mode: elements.quickSkillMode.value === "plan" ? "plan" : "execute",
      requiresSession: elements.quickSkillRequiresSession.checked
    };
    if (!body.title || !body.prompt) {
      app.toast("名称和指令不能为空");
      return;
    }
    if (body.scope === "project" && !body.projectId) {
      app.toast("先选择工程，或保存为全局指令");
      return;
    }

    state.quickSkillsBusy = true;
    app.updateQuickSkillFormControls();
    try {
      if (id) {
        await app.apiPost(`/api/codex/quick-skills/${encodeURIComponent(id)}`, body);
        app.toast("已保存");
      } else {
        await app.apiPost("/api/codex/quick-skills", body);
        app.toast("已创建");
      }
      app.resetQuickSkillForm();
      await app.loadQuickSkills();
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
    } finally {
      state.quickSkillsBusy = false;
      app.updateQuickSkillFormControls();
    }
  };

  app.deleteEditingQuickSkill = async function deleteEditingQuickSkill() {
    const id = elements.quickSkillId.value.trim();
    if (!id) return;
    state.quickSkillsBusy = true;
    app.updateQuickSkillFormControls();
    try {
      await app.apiPost(`/api/codex/quick-skills/${encodeURIComponent(id)}/delete`, {});
      app.toast("已删除");
      app.resetQuickSkillForm();
      await app.loadQuickSkills();
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
    } finally {
      state.quickSkillsBusy = false;
      app.updateQuickSkillFormControls();
    }
  };

  app.sendCodexPrompt = async function sendCodexPrompt({ projectId, prompt, runtime, attachments, mode = "execute" }) {
    if (app.canContinueSelectedSession()) {
      return app.apiPost(`/api/codex/sessions/${encodeURIComponent(state.selectedCodexJobId)}/messages`, {
        projectId,
        text: prompt,
        runtime,
        attachments,
        mode
      });
    }
    if (!app.canStartNewSessionFromComposer()) {
      throw new Error("当前会话不能继续，请先从左上角新建会话。");
    }
    return app.apiPost("/api/codex/sessions", { projectId, prompt, runtime, attachments, mode });
  };

  app.canContinueSelectedSession = function canContinueSelectedSession() {
    return app.sessionCanAcceptFollowUp(app.selectedSessionForComposer());
  };

  app.selectedSessionForComposer = function selectedSessionForComposer() {
    if (state.composingNewSession) return null;
    if (!state.selectedCodexJobId || !state.selectedCodexSession) return null;
    if (!app.sessionBelongsToCurrentProject(state.selectedCodexSession)) return null;
    return state.selectedCodexSession;
  };

  app.canRunSessionQuickSkill = function canRunSessionQuickSkill() {
    const session = app.selectedSessionForComposer();
    return Boolean(session && app.sessionCanAcceptFollowUp(session) && !app.sessionHasPendingWork(session));
  };

  app.toggleComposerPlanMode = function toggleComposerPlanMode() {
    app.setComposerPlanMode(!state.composerPlanMode);
  };

  app.setComposerPlanMode = function setComposerPlanMode(enabled) {
    state.composerPlanMode = Boolean(enabled);
    localStorage.setItem("echoComposerMode", state.composerPlanMode ? "plan" : "execute");
    app.updateComposerModeControls();
    app.updateComposerAvailability();
  };

  app.updateComposerModeControls = function updateComposerModeControls() {
    if (!elements.composerPlanModeButton) return;
    const enabled = Boolean(state.composerPlanMode);
    elements.composerPlanModeButton.classList.toggle("active", enabled);
    elements.composerPlanModeButton.setAttribute("aria-pressed", enabled ? "true" : "false");
    elements.composerPlanModeButton.setAttribute("aria-label", enabled ? "退出计划模式" : "进入计划模式");
    elements.composerPlanModeButton.setAttribute("title", enabled ? "退出计划模式" : "进入计划模式");
  };

  app.requestContextCompaction = async function requestContextCompaction({ automatic = false } = {}) {
    if (!app.codexCommandsAvailable()) {
      if (!automatic) app.toast(state.codexConnectionState === "error" ? "连接恢复后再压缩" : "桌面 agent 在线后再压缩");
      return;
    }
    const session = app.selectedSessionForComposer();
    if (!session || !app.canCompactSelectedSession(session)) {
      if (!automatic) app.toast("当前会话暂时不能压缩");
      return;
    }

    state.autoCompactedSessionIds.add(session.id);
    if (!automatic) app.setComposerBusy(true, "压缩中");
    try {
      const data = await app.apiPost(`/api/codex/sessions/${encodeURIComponent(session.id)}/compact`, {
        automatic,
        reason: automatic ? "context-threshold" : "manual"
      });
      state.selectedCodexSession = data.session || session;
      app.renderCodexJob(state.selectedCodexSession, { keepSelection: true, scrollToBottom: automatic });
      app.scheduleSessionListRefresh?.({ delayMs: 250 });
      if (!automatic) app.toast("已请求压缩上下文");
    } catch (error) {
      state.autoCompactedSessionIds.delete(session.id);
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。") && !automatic) {
        app.toast(error.message);
      }
    } finally {
      if (!automatic) app.setComposerBusy(false);
    }
  };

  app.maybeAutoCompactContext = function maybeAutoCompactContext(usage, percent) {
    if (usage?.source !== "codex-app-server" || !Number.isFinite(percent) || percent < 85) return;
    const session = app.selectedSessionForComposer();
    if (!session || state.autoCompactedSessionIds.has(session.id) || app.sessionHasCompactionEvent(session)) return;
    if (elements.codexPrompt.value.trim() || state.composerAttachments.length > 0 || app.hasPendingComposerAttachments()) return;
    if (!app.canCompactSelectedSession(session)) return;
    app.requestContextCompaction({ automatic: true }).catch(() => {});
  };

  app.canCompactSelectedSession = function canCompactSelectedSession(session = app.selectedSessionForComposer()) {
    return Boolean(
      session &&
        session.appThreadId &&
        app.sessionCanAcceptFollowUp(session) &&
        !["failed", "closed", "stale", "cancelled"].includes(session.status) &&
        !app.sessionHasPendingWork(session) &&
        Number(session.pendingApprovalCount || 0) === 0 &&
        Number(session.pendingInteractionCount || 0) === 0
    );
  };

  app.sessionHasCompactionEvent = function sessionHasCompactionEvent(session) {
    return (session?.events || []).some((event) => {
      const eventType = String(event.type || "");
      const itemType = event.raw?.params?.item?.type || "";
      return eventType.includes("compaction") || eventType === "thread/compacted" || itemType === "contextCompaction";
    });
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
    if (state.selectedCodexSession && !app.sessionBelongsToCurrentProject(state.selectedCodexSession)) return true;
    return !state.selectedCodexJobId && !state.selectedCodexSession;
  };

  app.selectedSessionNeedsExplicitNew = function selectedSessionNeedsExplicitNew() {
    if (state.composingNewSession) return false;
    if (!state.selectedCodexJobId || !state.selectedCodexSession) return false;
    return !app.canContinueSelectedSession();
  };

  app.sessionHasPendingWork = function sessionHasPendingWork(session) {
    if (!session) return false;
    return (
      ["queued", "starting", "running"].includes(session.status) ||
      Number(session.pendingCommandCount || 0) > 0 ||
      Number(session.pendingInteractionCount || 0) > 0
    );
  };

  app.composerActionLabel = function composerActionLabel() {
    if (app.selectedSessionNeedsExplicitNew()) return "先新建";
    if (state.composerPlanMode) return "生成计划";
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
    const hasProject = Boolean(app.currentProjectId());
    const commandsAvailable = app.codexCommandsAvailable();
    const hasDraft = Boolean(elements.codexPrompt.value.trim()) || state.composerAttachments.length > 0;
    const blockedBySelectedSession = app.selectedSessionNeedsExplicitNew();
    const attachmentsPending = app.hasPendingComposerAttachments();
    elements.sendCodexButton.disabled =
      state.composerBusy || attachmentsPending || !commandsAvailable || !hasProject || !hasDraft || blockedBySelectedSession;
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
    if (elements.composerPlanModeButton) {
      elements.composerPlanModeButton.disabled = state.composerBusy;
    }
    if (elements.compactContextButton) {
      elements.compactContextButton.disabled =
        state.composerBusy || attachmentsPending || !commandsAvailable || hasDraft || !app.canCompactSelectedSession();
    }
    app.updateProjectCreateControls();
    if (elements.quickSkillsButton) {
      elements.quickSkillsButton.disabled = state.composerBusy;
    }
    app.updateStopButton?.();
    app.refreshComposerMeta();
    app.refreshTopbarProjectChip();
    app.updateComposerModeControls();
    app.syncComposerMetrics();
    app.refreshComposerStatusBar();
  };

  app.codexCommandsAvailable = function codexCommandsAvailable() {
    if (state.codexConnectionState === "error" || !state.codexAgentAvailable) return false;
    const projectId = app.currentProjectId();
    return Boolean(projectId && (state.codexWorkspaces || []).some((workspace) => workspace.id === projectId));
  };

  app.toggleProjectCreateForm = function toggleProjectCreateForm() {
    if (state.projectCreateBusy || !state.codexAgentOnline) {
      app.toast(state.codexAgentOnline ? "工程正在创建中" : "桌面 agent 在线后才能新建工程");
      return;
    }
    app.openProjectSwitcher();
    elements.projectCreateForm.hidden = !elements.projectCreateForm.hidden;
    if (!elements.projectCreateForm.hidden) {
      elements.projectSheetStatus.textContent = "会在桌面默认工程目录下创建，并自动加入工程列表。";
      elements.projectCreateName.focus({ preventScroll: true });
    }
  };

  app.createProjectFromMobile = async function createProjectFromMobile(event) {
    event?.preventDefault();
    if (!state.codexAgentOnline) {
      app.toast("桌面 agent 在线后才能新建工程");
      return;
    }

    const name = elements.projectCreateName.value.trim();
    if (!name) {
      app.toast("先填写工程名称");
      elements.projectCreateName.focus({ preventScroll: true });
      return;
    }

    app.setProjectCreateBusy(true, "正在通知桌面 agent...");
    try {
      const created = await app.apiPost("/api/codex/workspaces", { name });
      const command = await app.waitForProjectCreateCommand(created.command?.id);
      const workspace = command.result?.workspace;
      if (!workspace?.id) throw new Error("桌面 agent 没有返回新工程信息。");

      localStorage.setItem("echoCodexProject", workspace.id);
      elements.projectCreateName.value = "";
      elements.projectCreateForm.hidden = true;
      await app.refreshCodex();
      await app.selectProject(workspace.id);
      elements.projectSheetStatus.textContent = `已创建 ${app.workspaceLabel(workspace)}`;
      app.toast(`已新建并切换到 ${app.workspaceLabel(workspace)}`);
      app.closeProjectSwitcher();
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        elements.projectSheetStatus.textContent = error.message;
        app.toast(error.message);
      }
    } finally {
      app.setProjectCreateBusy(false);
    }
  };

  app.waitForProjectCreateCommand = async function waitForProjectCreateCommand(commandId) {
    if (!commandId) throw new Error("新建工程请求没有排入队列。");

    const startedAt = Date.now();
    while (Date.now() - startedAt < 60000) {
      const data = await app.apiGet(`/api/codex/workspaces/${encodeURIComponent(commandId)}`);
      const command = data.command;
      if (command?.status === "done") return command;
      if (command?.status === "failed") {
        throw new Error(command.error || command.result?.error || "新建工程失败。");
      }
      elements.projectSheetStatus.textContent = command?.status === "leased" ? "桌面 agent 正在创建目录..." : "等待桌面 agent 创建目录...";
      await new Promise((resolve) => setTimeout(resolve, 900));
    }

    throw new Error("新建工程超时，请确认桌面 agent 已更新并在运行。");
  };

  app.setProjectCreateBusy = function setProjectCreateBusy(isBusy, message = "") {
    state.projectCreateBusy = isBusy;
    if (message) elements.projectSheetStatus.textContent = message;
    app.updateProjectCreateControls();
  };

  app.updateProjectCreateControls = function updateProjectCreateControls() {
    const disabled = state.projectCreateBusy || !state.codexAgentOnline;
    if (elements.newProjectButton) elements.newProjectButton.disabled = disabled;
    if (elements.projectCreateName) elements.projectCreateName.disabled = state.projectCreateBusy;
    if (elements.projectCreateSubmit) {
      elements.projectCreateSubmit.disabled = disabled;
      elements.projectCreateSubmit.textContent = state.projectCreateBusy ? "创建中" : "创建";
    }
  };

  app.updateProjectSummary = function updateProjectSummary(workspace, hasProjects, agentOnline = state.codexAgentOnline) {
    if (workspace) {
      elements.projectPickerLabel.textContent = app.workspaceDirectoryName(workspace);
      elements.projectPickerMeta.textContent = "";
      return;
    }
    elements.projectPickerLabel.textContent = hasProjects ? "选择工程" : agentOnline ? "还没有工程" : "等待桌面 agent";
    elements.projectPickerMeta.textContent = hasProjects
      ? `已同步 ${state.codexWorkspaces.length} 个项目。`
      : agentOnline
        ? "可以新建工程，或去桌面端添加允许的项目。"
        : "桌面端启动后会同步可切换项目。";
  };

  app.renderProjectPicker = function renderProjectPicker(agentOnline) {
    const selectedWorkspace = state.codexWorkspaces.find((workspace) => workspace.id === elements.codexProject.value) || null;
    const hasProjects = state.codexWorkspaces.length > 0;
    app.updateProjectSummary(selectedWorkspace, hasProjects, agentOnline);
    app.updateProjectCreateControls();

    if (!hasProjects) {
      elements.projectSheetStatus.textContent = "";
      app.renderProjectSheetList();
      app.refreshActiveSessionHeader();
      app.refreshTopbarProjectChip();
      return;
    }

    elements.projectSheetStatus.textContent = "";
    app.renderProjectSheetList();
    app.refreshActiveSessionHeader();
    app.refreshTopbarProjectChip();
  };

  app.renderProjectSheetList = function renderProjectSheetList() {
    const sessionList = elements.codexJobs;
    if (sessionList && elements.projectSheetList.contains(sessionList)) sessionList.remove();
    elements.projectSheetList.innerHTML = "";
    if (!state.codexWorkspaces.length) {
      elements.projectSheetList.innerHTML = '<div class="project-sheet-empty">暂时没有可切换工程。</div>';
      return;
    }

    for (const workspace of state.codexWorkspaces) {
      const group = document.createElement("div");
      const button = document.createElement("button");
      const isActive = workspace.id === elements.codexProject.value;
      const directoryName = app.workspaceDirectoryName(workspace);
      const secondaryLabel = workspace.label && workspace.label !== directoryName ? workspace.label : app.workspaceSecondaryLabel(workspace);
      const pathLabel = app.workspacePathLabel(workspace) || app.workspaceMeta(workspace);
      group.className = "project-tree-group";
      group.classList.toggle("active", isActive);
      button.type = "button";
      button.className = "project-option project-tree-project";
      button.dataset.projectId = workspace.id || "";
      button.title = pathLabel;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", isActive ? "true" : "false");
      button.classList.toggle("active", isActive);
      button.innerHTML = `
        <span class="project-option-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.7" />
          </svg>
        </span>
        <div class="project-option-main">
          <div class="project-option-title-row">
            <strong>${app.escapeHtml(directoryName)}</strong>
          </div>
          ${secondaryLabel ? `<span class="project-option-id">${app.escapeHtml(secondaryLabel)}</span>` : ""}
        </div>
      `;
      button.addEventListener("click", () => app.selectProject(workspace.id));
      group.append(button);
      if (isActive && sessionList) {
        sessionList.classList.add("project-session-list");
        group.append(sessionList);
      }
      elements.projectSheetList.append(group);
    }
  };

  app.handleGlobalKeydown = function handleGlobalKeydown(event) {
    if (event.key !== "Escape") return;
    if (elements.quickSkillsPanel && !elements.quickSkillsPanel.hidden) {
      event.preventDefault();
      app.closeQuickSkillsPanel({ restoreFocus: true });
      return;
    }
    if (elements.codexView.classList.contains("sessions-open")) {
      event.preventDefault();
      app.closeSessionSidebar();
    }
  };

  app.selectProject = async function selectProject(projectId) {
    if (!projectId) return;
    const previous = elements.codexProject.value;
    elements.codexProject.value = projectId;
    localStorage.setItem("echoCodexProject", projectId);
    if (previous !== projectId) {
      state.composingNewSession = false;
      state.selectedCodexJobId = "";
      state.selectedCodexSession = null;
      app.closeCodexSessionStream?.();
      app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
      app.renderEmptySessionDetail({ title: "切换工程", body: "正在打开这个工程的最近会话。" });
      elements.codexJobs.innerHTML = '<div class="empty-state">正在加载会话...</div>';
    }
    app.syncProjectPicker();
    app.updateComposerAvailability();
    if (previous && previous !== projectId) {
      app.toast(`已切换到 ${app.workspaceLabel(state.codexWorkspaces.find((workspace) => workspace.id === projectId) || { id: projectId })}`);
    }
    app.closeProjectSwitcher();
    if (previous !== projectId) {
      try {
        await app.loadQuickSkills({ silent: true });
        await app.loadCodexJobs();
      } catch (error) {
        if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
          app.toast(error.message);
        }
      }
    }
  };

  app.syncProjectPicker = function syncProjectPicker() {
    const workspace = state.codexWorkspaces.find((item) => item.id === elements.codexProject.value);
    const hasProjects = state.codexWorkspaces.length > 0;
    app.updateProjectSummary(workspace, hasProjects);
    app.refreshTopbarProjectChip();
    app.renderProjectSheetList();
    app.refreshActiveSessionHeader();
  };
}
