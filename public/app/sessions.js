const RUNNING_ACTIVITY_QUIET_MS = 90 * 1000;
const RUNNING_ACTIVITY_STALE_MS = 5 * 60 * 1000;

export function installSessions(app) {
  const { document, elements, navigator, state, window: windowRef } = app;

  app.loadCodexJobs = async function loadCodexJobs(options = {}) {
    const projectId = app.currentProjectId();
    if (!projectId) {
      await app.renderProjectSessionList([]);
      state.selectedCodexSession = null;
      state.selectedCodexJobId = "";
      app.closeCodexSessionStream();
      app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
      app.renderEmptySessionDetail({ title: "选择工程", body: "先选择工程，再开始或继续会话。" });
      return;
    }

    const params = new URLSearchParams({
      archived: state.showArchivedSessions ? "true" : "false",
      projectId
    });
    const data = await app.apiGet(`/api/codex/sessions?${params.toString()}`);
    const jobs = data.items.slice(0, 30);
    await app.renderProjectSessionList(jobs, options);
  };

  app.renderProjectSessionList = async function renderProjectSessionList(jobs, options = {}) {
    elements.codexJobs.innerHTML = "";
    if (jobs.length === 0) {
      const emptyCopy = state.showArchivedSessions ? "还没有归档会话" : "还没有 Codex 会话";
      elements.codexJobs.innerHTML = `<div class="empty-state">${app.escapeHtml(emptyCopy)}</div>`;
      state.selectedCodexSession = null;
      if (!state.composingNewSession) {
        state.selectedCodexJobId = "";
        app.closeCodexSessionStream();
        app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
        app.renderEmptySessionDetail({
          title: state.showArchivedSessions ? "归档" : "新会话",
          body: state.showArchivedSessions ? "这里暂时没有归档会话。" : "直接发送，开始新的 Codex 会话。"
        });
      }
      return;
    }

    const selectedSessionMatchesProject =
      state.selectedCodexSession?.id === state.selectedCodexJobId &&
      app.sessionBelongsToCurrentProject(state.selectedCodexSession);
    if (state.selectedCodexJobId && !selectedSessionMatchesProject && !jobs.some((job) => job.id === state.selectedCodexJobId)) {
      state.selectedCodexJobId = "";
      state.selectedCodexSession = null;
      app.closeCodexSessionStream();
    }

    if (!state.selectedCodexJobId && !state.composingNewSession) {
      state.selectedCodexJobId = app.preferredSession(jobs)?.id || jobs[0].id;
    } else if (state.selectedCodexJobId && !jobs.some((job) => job.id === state.selectedCodexJobId)) {
      state.selectedCodexJobId = state.composingNewSession ? "" : app.preferredSession(jobs)?.id || jobs[0].id;
    }

    for (const job of jobs) {
      elements.codexJobs.append(app.renderSessionButton(job));
    }

    if (state.selectedCodexJobId) {
      if (options.skipSelectedDetailLoad && state.selectedCodexSession?.id === state.selectedCodexJobId) {
        app.refreshActiveSessionHeader();
        app.updateComposerAvailability();
        app.updateStopButton();
        return;
      }
      await app.showCodexJob(state.selectedCodexJobId, { keepSelection: true });
      return;
    }

    state.selectedCodexSession = null;
    app.closeCodexSessionStream();
    app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
    app.renderEmptySessionDetail({ title: "新会话", body: "直接发送，开始新的 Codex 会话。" });
  };

  app.renderSessionButton = function renderSessionButton(job) {
    const item = document.createElement("div");
    item.dataset.jobId = job.id;
    item.className = "conversation-item";
    item.classList.toggle("active", job.id === state.selectedCodexJobId);
    const archived = Boolean(job.archivedAt);
    const pendingInteractionCount = Number(job.pendingInteractionCount || 0);
    const pendingApprovalCount = Number(job.pendingApprovalCount || 0);
    const canArchive =
      !["queued", "starting", "running"].includes(job.status) &&
      !pendingApprovalCount &&
      !pendingInteractionCount &&
      !job.pendingCommandCount;
    const alertText = app.sessionPendingDecisionText(job);
    item.innerHTML = `
      <button class="conversation-item-open" type="button">
        <div class="conversation-item-head">
          <strong>${app.escapeHtml(app.jobTitle(job))}</strong>
          <span class="conversation-item-time">${app.escapeHtml(app.formatRelativeTime(app.sessionTime(job)))}</span>
        </div>
        <div class="conversation-item-meta">
          <span class="conversation-item-status ${app.escapeHtml(job.status)}">${app.escapeHtml(app.statusLabel(job.status))}</span>
          <span>${app.escapeHtml(app.sessionProjectLabel(job.projectId))}</span>
        </div>
        <span class="conversation-item-preview">${app.escapeHtml(app.jobPreview(job))}</span>
        ${alertText ? `<span class="conversation-item-alert">${app.escapeHtml(alertText)}</span>` : ""}
      </button>
      <button class="conversation-item-archive" type="button" ${canArchive || archived ? "" : "disabled"}>
        ${archived ? "恢复" : "归档"}
      </button>
    `;
    item.querySelector(".conversation-item-open").addEventListener("click", () => {
      state.composingNewSession = false;
      app.showCodexJob(job.id);
      app.closeSessionSidebar({ restoreFocus: false });
    });
    item.querySelector(".conversation-item-archive").addEventListener("click", () => app.archiveSession(job.id, !archived));
    return item;
  };

  app.archiveSession = async function archiveSession(sessionId, archived) {
    try {
      await app.apiPost(`/api/codex/sessions/${encodeURIComponent(sessionId)}/archive`, { archived });
      app.toast(archived ? "已归档" : "已恢复");
      if (sessionId === state.selectedCodexJobId) {
        state.selectedCodexJobId = "";
        state.selectedCodexSession = null;
        app.renderEmptySessionDetail(
          archived ? { title: "已归档", body: "这个会话已移到归档。" } : { title: "已恢复", body: "这个会话已经回到最近列表。" }
        );
      }
      await app.loadCodexJobs();
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    }
  };

  app.cancelSelectedCodexTurn = async function cancelSelectedCodexTurn() {
    const session = state.selectedCodexSession;
    if (!session?.id || !app.canCancelSession(session)) return;

    elements.stopCodexTurnButton.disabled = true;
    try {
      const data = await app.apiPost(`/api/codex/sessions/${encodeURIComponent(session.id)}/cancel`, {
        reason: "Cancelled from mobile."
      });
      state.selectedCodexSession = data.session || session;
      app.toast("已请求中断");
      await app.showCodexJob(session.id, { keepSelection: true });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    } finally {
      app.updateStopButton();
    }
  };

  app.canCancelSession = function canCancelSession(session) {
    if (!session || session.archivedAt) return false;
    if (session.status === "queued") return true;
    if (session.status === "starting" || session.status === "running") return true;
    if (Number(session.pendingCommandCount || 0) > 0 && !["cancelled", "closed", "failed", "stale"].includes(session.status)) return true;
    return Boolean(session.activeTurnId);
  };

  app.updateStopButton = function updateStopButton() {
    if (!elements.stopCodexTurnButton) return;
    const session = state.composingNewSession ? null : state.selectedCodexSession;
    const canCancel = app.canCancelSession(session);
    const cancelRequested = app.sessionCancelRequested(session);
    elements.stopCodexTurnButton.hidden = !canCancel;
    elements.stopCodexTurnButton.disabled = state.composerBusy || !canCancel || cancelRequested;
    const label = cancelRequested ? "正在中断当前 Codex turn" : "中断当前 Codex turn";
    elements.stopCodexTurnButton.setAttribute("aria-label", label);
    elements.stopCodexTurnButton.setAttribute("title", label);
  };

  app.sessionCancelRequested = function sessionCancelRequested(session) {
    if (!session) return false;
    const events = session.events || [];
    const latestCancel = [...events].reverse().find((event) => event.type === "turn.cancel.requested");
    if (!latestCancel) return false;
    const latestDone = [...events].reverse().find((event) =>
      ["turn.interrupted", "turn/completed", "session.cancelled", "command.failed", "command.completed"].includes(event.type)
    );
    if (!latestDone) return true;
    return Number(latestCancel.id || 0) > Number(latestDone.id || 0);
  };

  app.preferredSession = function preferredSession(jobs) {
    return (
      jobs.find((job) => Number(job.pendingInteractionCount || 0) > 0) ||
      jobs.find((job) => job.pendingApprovalCount > 0) ||
      jobs.find((job) => ["queued", "starting", "running"].includes(job.status)) ||
      jobs.find((job) => job.status === "active") ||
      jobs[0]
    );
  };

  app.sessionPendingDecisionText = function sessionPendingDecisionText(session) {
    const interactionCount = Number(session?.pendingInteractionCount || 0);
    if (interactionCount > 0) return `${interactionCount} 个待选择`;
    const approvalCount = Number(session?.pendingApprovalCount || 0);
    if (approvalCount > 0) return `${approvalCount} 个待审批`;
    return "";
  };

  app.statusLabel = function statusLabel(status) {
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
  };

  app.showCodexJob = async function showCodexJob(id, options = {}) {
    const previousSessionId = state.selectedCodexSession?.id || state.selectedCodexJobId;
    const switchingSession = Boolean(previousSessionId && previousSessionId !== id);
    state.selectedCodexJobId = id;
    if (options.resetComposerAttachments || switchingSession) {
      app.clearComposerAttachments({ silent: true });
    }
    if (!options.keepSelection) {
      for (const button of elements.codexJobs.querySelectorAll(".conversation-item")) {
        button.classList.toggle("active", button.dataset.jobId === id);
      }
    }
    const data = await app.apiGet(`/api/codex/sessions/${encodeURIComponent(id)}`);
    if (!app.sessionBelongsToCurrentProject(data.session)) {
      state.selectedCodexJobId = "";
      state.selectedCodexSession = null;
      app.closeCodexSessionStream();
      app.renderEmptySessionDetail({ title: "新会话", body: "这个工程还没有打开的会话。" });
      app.updateComposerAvailability();
      return;
    }
    app.openCodexSessionStream(id);
    app.renderCodexJob(data.session, { ...options, previousSessionId, switchingSession });
  };

  app.renderCodexJob = function renderCodexJob(job, options = {}) {
    if (!job?.id) return;
    const previousSessionId = options.previousSessionId || state.selectedCodexSession?.id || state.selectedCodexJobId;
    const switchingSession = options.switchingSession ?? Boolean(previousSessionId && previousSessionId !== job.id);
    const shouldScrollToBottom = options.scrollToBottom !== false && (!state.selectedCodexSession || switchingSession || !options.keepSelection);
    const scrollSnapshot = options.keepSelection ? app.conversationScrollSnapshot() : null;
    const preserveCurrentView = Boolean(options.keepSelection && !switchingSession);
    const forceTopbarVisible = !preserveCurrentView;
    state.selectedCodexJobId = job.id;
    state.selectedCodexSession = job;
    if (Number(job.lastEventId || 0) > 0) state.sessionLastEventIds.set(job.id, Number(job.lastEventId));
    if (!(options.keepSelection && state.runtimeDirty)) {
      app.applyRuntimeDraft(app.runtimeChoiceWithFallback(job.runtime, state.runtimePreferences), {
        persist: false,
        dirty: false
      });
    }
    const errorText = app.humanizeCodexError(job.error || job.lastError);
    const timeline = app.buildConversationTimeline(job, errorText);
    const renderSignature = app.sessionRenderSignature(job, errorText, timeline);
    const canSkipDetailRender =
      preserveCurrentView &&
      state.renderedCodexSessionId === job.id &&
      state.renderedCodexSessionSignature === renderSignature;

    if (canSkipDetailRender) {
      app.renderCodexLog(job, errorText);
      app.renderSessionStatusRail(job);
      app.refreshActiveSessionHeader();
      app.updateComposerAvailability();
      app.updateStopButton();
      return;
    }

    elements.codexJobDetail.hidden = false;
    elements.runLog.hidden = false;
    elements.activeSessionTitle.textContent = app.jobTitle(job);
    elements.codexRunSummary.innerHTML = `
      <div class="conversation-thread">
        ${timeline.map((entry) => app.renderConversationEntry(entry)).join("")}
      </div>
    `;
    state.renderedCodexSessionId = job.id;
    state.renderedCodexSessionSignature = renderSignature;
    app.renderSessionStatusRail(job);
    app.renderApprovals(job);
    app.renderCodexLog(job, errorText);
    app.refreshActiveSessionHeader();
    app.updateComposerAvailability();
    app.updateStopButton();
    if (shouldScrollToBottom || app.wasConversationNearBottom(scrollSnapshot)) {
      app.scrollConversationToBottom({ forceTopbarVisible });
    } else if (scrollSnapshot) {
      app.restoreConversationScroll(scrollSnapshot, { forceTopbarVisible });
    } else if (forceTopbarVisible) {
      app.resetTopbarScrollTracking({ forceVisible: true });
    }
  };

  app.openCodexSessionStream = async function openCodexSessionStream(sessionId, options = {}) {
    if (!windowRef.EventSource || !sessionId || state.sessionEventSourceId === sessionId) return;
    app.closeCodexSessionStream({ keepLastEventId: true });

    let ticket = "";
    try {
      const data = await app.apiPost(`/api/codex/sessions/${encodeURIComponent(sessionId)}/events-ticket`, {});
      ticket = String(data.ticket || "");
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.markCodexConnectionProblem?.("实时更新连接失败，当前会话已保留。");
      }
      return;
    }
    if (!ticket || state.selectedCodexJobId !== sessionId) return;

    const lastEventId = options.reconnect ? app.lastKnownSessionEventId(sessionId) : 0;
    const params = new URLSearchParams({ ticket });
    if (lastEventId > 0) params.set("after", String(lastEventId));
    const source = new EventSource(`/api/codex/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`);
    state.sessionEventSource = source;
    state.sessionEventSourceId = sessionId;

    source.addEventListener("open", () => {
      if (state.sessionEventSource !== source) return;
      state.sessionEventReconnectAttempts = 0;
      if (state.codexConnectionState === "error") {
        state.codexConnectionState = state.codexAgentOnline ? "online" : "waiting";
        app.setTopbarStatus(state.codexAgentOnline ? "Codex 在线" : "等待桌面 agent", state.codexAgentOnline ? "online" : "idle");
        app.updateComposerAvailability();
      }
    });

    source.addEventListener("session", (event) => {
      let data = null;
      try {
        data = JSON.parse(event.data || "{}");
      } catch {
        return;
      }
      const session = data?.session;
      if (!session?.id || session.id !== state.selectedCodexJobId) return;
      const eventId = Number(event.lastEventId || data.lastEventId || session.lastEventId || 0);
      if (Number.isFinite(eventId) && eventId > 0) state.sessionLastEventIds.set(session.id, eventId);
      app.queueCodexSessionStreamRender(session, { partial: Boolean(data.partial) });
    });

    source.onerror = () => {
      if (state.sessionEventSource !== source) return;
      app.markCodexConnectionProblem?.("实时更新中断，当前会话已保留。");
      source.close();
      state.sessionEventSource = null;
      state.sessionEventSourceId = "";
      app.scheduleCodexSessionStreamReconnect(sessionId);
      app.scheduleSessionListRefresh();
    };
  };

  app.scheduleCodexSessionStreamReconnect = function scheduleCodexSessionStreamReconnect(sessionId) {
    if (!sessionId || state.sessionEventReconnectTimer) return;
    const attempts = Math.min(Number(state.sessionEventReconnectAttempts || 0) + 1, 6);
    state.sessionEventReconnectAttempts = attempts;
    const delay = Math.min(30000, 1200 * attempts);
    state.sessionEventReconnectTimer = windowRef.setTimeout(() => {
      state.sessionEventReconnectTimer = null;
      if (state.selectedCodexJobId !== sessionId) return;
      app.openCodexSessionStream(sessionId, { reconnect: true }).catch(() => {
        app.scheduleCodexSessionStreamReconnect(sessionId);
      });
    }, delay);
  };

  app.closeCodexSessionStream = function closeCodexSessionStream(options = {}) {
    if (state.sessionEventSource) {
      state.sessionEventSource.close();
      state.sessionEventSource = null;
    }
    if (state.sessionEventReconnectTimer) {
      windowRef.clearTimeout(state.sessionEventReconnectTimer);
      state.sessionEventReconnectTimer = null;
    }
    if (state.sessionListRefreshTimer) {
      windowRef.clearTimeout(state.sessionListRefreshTimer);
      state.sessionListRefreshTimer = null;
    }
    state.sessionEventSourceId = "";
    if (!options.keepLastEventId && state.selectedCodexJobId) {
      state.sessionLastEventIds.delete(state.selectedCodexJobId);
    }
    if (state.sessionStreamRenderFrame) {
      windowRef.cancelAnimationFrame?.(state.sessionStreamRenderFrame);
      state.sessionStreamRenderFrame = 0;
    }
    state.pendingSessionStreamRender = null;
  };

  app.queueCodexSessionStreamRender = function queueCodexSessionStreamRender(session, options = {}) {
    state.pendingSessionStreamRender = {
      session,
      partial: Boolean(options.partial)
    };
    if (state.sessionStreamRenderFrame) return;

    const render = () => {
      state.sessionStreamRenderFrame = 0;
      const pending = state.pendingSessionStreamRender;
      state.pendingSessionStreamRender = null;
      const nextSession = pending?.partial
        ? app.mergeCodexSessionStreamUpdate(state.selectedCodexSession, pending.session)
        : pending?.session;
      if (!nextSession?.id || nextSession.id !== state.selectedCodexJobId) return;
      app.renderCodexJob(nextSession, { keepSelection: true, scrollToBottom: false });
      if (!app.sessionHasPendingWork(nextSession)) app.scheduleSessionListRefresh();
    };

    if (windowRef.requestAnimationFrame) {
      state.sessionStreamRenderFrame = windowRef.requestAnimationFrame(render);
    } else {
      render();
    }
  };

  app.mergeCodexSessionStreamUpdate = function mergeCodexSessionStreamUpdate(current, incoming) {
    if (!current || current.id !== incoming?.id) return incoming;
    return {
      ...current,
      ...incoming,
      messages: Array.isArray(incoming.messages) ? incoming.messages : current.messages || [],
      approvals: Array.isArray(incoming.approvals) ? incoming.approvals : current.approvals || [],
      interactions: Array.isArray(incoming.interactions) ? incoming.interactions : current.interactions || [],
      events: app.mergeCodexSessionEvents(current.events || [], incoming.events || [])
    };
  };

  app.mergeCodexSessionEvents = function mergeCodexSessionEvents(currentEvents, incomingEvents) {
    const merged = [];
    const seen = new Set();
    for (const event of [...currentEvents, ...incomingEvents]) {
      const key = app.sessionEventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(event);
    }
    return merged.slice(-160);
  };

  app.sessionEventKey = function sessionEventKey(event) {
    if (event?.id) return `id:${event.id}`;
    const raw = event?.raw || {};
    const params = raw.params || {};
    const item = params.item || {};
    return [
      event?.at || "",
      event?.type || "",
      raw.method || "",
      params.threadId || "",
      params.turnId || params.turn?.id || "",
      params.itemId || item.id || "",
      String(event?.text || "").slice(0, 160)
    ].join("\u001f");
  };

  app.lastKnownSessionEventId = function lastKnownSessionEventId(sessionId) {
    const stored = Number(state.sessionLastEventIds.get(sessionId) || 0);
    const session = state.selectedCodexSession?.id === sessionId ? state.selectedCodexSession : null;
    const fromSession = Number(session?.lastEventId || 0);
    const fromEvents = Math.max(0, ...(session?.events || []).map((event) => Number(event.id || 0)).filter(Number.isFinite));
    return Math.max(stored, fromSession, fromEvents);
  };

  app.scheduleSessionListRefresh = function scheduleSessionListRefresh() {
    if (state.sessionListRefreshTimer) return;
    state.sessionListRefreshTimer = windowRef.setTimeout(() => {
      state.sessionListRefreshTimer = null;
      if (app.isLoggedIn() && state.token) {
        app.loadCodexJobs({ skipSelectedDetailLoad: Boolean(state.sessionEventSourceId) }).catch((error) => {
          if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
            app.markCodexConnectionProblem?.("连接中断，当前会话已保留。");
          }
        });
      }
    }, 1200);
  };

  app.renderCodexLog = function renderCodexLog(job, errorText = "") {
    const lines = [
      `# ${job.status} · ${job.projectId}`,
      errorText ? `ERROR: ${errorText}` : "",
      job.finalMessage ? `\nFinal:\n${job.finalMessage}` : "",
      "\nEvents:",
      ...(job.events || []).slice(-80).map((event) => `${event.at || ""} ${event.type || ""}\n${event.text || ""}`)
    ].filter(Boolean);
    elements.codexLog.textContent = lines.join("\n\n");
  };

  app.conversationScrollTarget = function conversationScrollTarget() {
    return app.usesCompactTopbarMode() ? elements.codexJobDetail : elements.codexRunSummary;
  };

  app.conversationScrollSnapshot = function conversationScrollSnapshot() {
    const target = app.conversationScrollTarget();
    if (!target) return null;
    return {
      scrollTop: target.scrollTop,
      distanceToBottom: Math.max(0, target.scrollHeight - target.clientHeight - target.scrollTop)
    };
  };

  app.wasConversationNearBottom = function wasConversationNearBottom(snapshot) {
    return Boolean(snapshot) && snapshot.distanceToBottom <= 48;
  };

  app.restoreConversationScroll = function restoreConversationScroll(snapshot, options = {}) {
    const forceTopbarVisible = options.forceTopbarVisible !== false;
    const restore = () => {
      const target = app.conversationScrollTarget();
      if (!target) return;
      target.scrollTop = snapshot.scrollTop;
      app.resetTopbarScrollTracking({ forceVisible: forceTopbarVisible });
    };

    windowRef.requestAnimationFrame(() => {
      restore();
      windowRef.requestAnimationFrame(restore);
    });
  };

  app.scrollConversationToBottom = function scrollConversationToBottom(options = {}) {
    const forceTopbarVisible = options.forceTopbarVisible !== false;
    const targets = [elements.codexRunSummary, elements.codexJobDetail].filter(Boolean);
    const scroll = () => {
      for (const target of targets) {
        if (target.hidden) continue;
        target.scrollTop = target.scrollHeight;
      }
      app.resetTopbarScrollTracking({ forceVisible: forceTopbarVisible });
    };

    windowRef.requestAnimationFrame(() => {
      scroll();
      windowRef.requestAnimationFrame(scroll);
    });
  };

  app.renderEmptySessionDetail = function renderEmptySessionDetail({ title, body }) {
    elements.codexJobDetail.hidden = false;
    elements.activeSessionTitle.textContent = title;
    state.renderedCodexSessionId = "";
    state.renderedCodexSessionSignature = "";
    elements.codexApprovals.hidden = true;
    elements.codexApprovals.innerHTML = "";
    state.contextUsageDetailsOpen = false;
    app.renderSessionStatusRail(null);
    app.refreshContextUsageIndicator?.();
    elements.runLog.hidden = true;
    elements.codexLog.textContent = "";
    elements.codexRunSummary.innerHTML = `
      <div class="conversation-thread conversation-thread-empty">
        <div class="thread-welcome">
          <strong>${app.escapeHtml(title)}</strong>
          <p>${app.escapeHtml(body)}</p>
        </div>
      </div>
    `;
    app.refreshActiveSessionHeader();
    app.updateStopButton();
    app.resetTopbarScrollTracking({ forceVisible: true });
  };

  app.renderApprovals = function renderApprovals(session) {
    const approvals = session.approvals || [];
    const interactions = session.interactions || [];
    elements.codexApprovals.hidden = approvals.length === 0 && interactions.length === 0;
    elements.codexApprovals.innerHTML = "";
    for (const approval of approvals) {
      const node = document.createElement("div");
      node.className = "approval-inline-card";
      node.innerHTML = `
        <div class="approval-inline-copy">
          <span class="thread-status-pill warn">${app.escapeHtml(app.approvalTitle(approval))}</span>
          <p>${app.escapeHtml(approval.prompt || approval.method || "Codex 请求审批")}</p>
          <pre>${app.escapeHtml(app.approvalDetail(approval))}</pre>
        </div>
        <div class="approval-actions">
          <button class="secondary" type="button" data-decision="denied">拒绝</button>
          <button class="primary" type="button" data-decision="approved">批准</button>
        </div>
      `;
      for (const button of node.querySelectorAll("button")) {
        button.addEventListener("click", () => app.decideApproval(session.id, approval.id, button.dataset.decision));
      }
      elements.codexApprovals.append(node);
    }
    for (const interaction of interactions) {
      elements.codexApprovals.append(app.renderInteractionCard(session, interaction));
    }
  };

  app.decideApproval = async function decideApproval(sessionId, approvalId, decision) {
    try {
      await app.apiPost(`/api/codex/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, {
        decision
      });
      app.toast(decision === "approved" ? "已批准" : "已拒绝");
      await app.showCodexJob(sessionId, { keepSelection: true });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    }
  };

  app.approvalTitle = function approvalTitle(approval) {
    if (approval.method === "item/commandExecution/requestApproval" || approval.method === "execCommandApproval") {
      return "命令审批";
    }
    if (approval.method === "item/fileChange/requestApproval" || approval.method === "applyPatchApproval") {
      return "文件修改审批";
    }
    return "Codex 审批";
  };

  app.approvalDetail = function approvalDetail(approval) {
    const payload = approval.payload || {};
    if (payload.command) return Array.isArray(payload.command) ? payload.command.join(" ") : String(payload.command);
    if (payload.cwd || payload.reason) return [payload.cwd, payload.reason].filter(Boolean).join("\n");
    if (payload.grantRoot) return String(payload.grantRoot);
    if (payload.changes) return payload.changes.map((change) => change.path || change.kind || "").filter(Boolean).join("\n");
    return JSON.stringify(payload, null, 2).slice(0, 1600);
  };

  app.renderInteractionCard = function renderInteractionCard(session, interaction) {
    const node = document.createElement("div");
    node.className = "approval-inline-card interaction-inline-card";
    const questions = app.interactionQuestions(interaction);
    node.innerHTML = `
      <div class="approval-inline-copy">
        <span class="thread-status-pill warn">${app.escapeHtml(app.interactionTitle(interaction))}</span>
        <p>${app.escapeHtml(interaction.prompt || "Codex 需要你的输入")}</p>
      </div>
      <form class="interaction-form">
        <div class="interaction-questions">
          ${questions.map((question) => app.renderInteractionQuestion(question)).join("")}
        </div>
        <div class="approval-actions">
          <button class="secondary" type="button" data-interaction-cancel>取消</button>
          <button class="primary" type="submit">提交</button>
        </div>
      </form>
    `;
    const form = node.querySelector(".interaction-form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      app.submitInteractionAnswer(session.id, interaction, form);
    });
    node.querySelector("[data-interaction-cancel]")?.addEventListener("click", () => {
      app.decideInteraction(session.id, interaction.id, { decision: "cancel" });
    });
    return node;
  };

  app.interactionTitle = function interactionTitle(interaction) {
    if (interaction.kind === "user_input" || /requestUserInput/i.test(interaction.method || "")) return "需要选择";
    return "Codex 请求";
  };

  app.interactionQuestions = function interactionQuestions(interaction) {
    const payload = interaction.payload || {};
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    return questions.length > 0
      ? questions.slice(0, 3)
      : [
          {
            id: "answer",
            header: "输入",
            question: interaction.prompt || "Codex 需要你的输入",
            options: null
          }
        ];
  };

  app.renderInteractionQuestion = function renderInteractionQuestion(question) {
    const id = app.safeInteractionFieldId(question.id);
    const header = String(question.header || "").trim();
    const prompt = String(question.question || "").trim();
    const options = Array.isArray(question.options) ? question.options : [];
    const secret = Boolean(question.isSecret || question.is_secret);
    const other = Boolean(question.isOther || question.is_other);
    const labelHtml = `
      <div class="interaction-question-copy">
        ${header ? `<strong>${app.escapeHtml(header)}</strong>` : ""}
        ${prompt ? `<span>${app.escapeHtml(prompt)}</span>` : ""}
      </div>
    `;
    if (options.length > 0) {
      const optionHtml = options
        .map((option, index) => {
          const value = String(option.label || "").trim();
          const description = String(option.description || "").trim();
          return `
            <label class="interaction-option">
              <input type="radio" name="${app.escapeHtml(id)}" value="${app.escapeHtml(value)}" ${index === 0 ? "checked" : ""}>
              <span>${app.escapeHtml(value)}</span>
              ${description ? `<small>${app.escapeHtml(description)}</small>` : ""}
            </label>
          `;
        })
        .join("");
      const otherHtml = other
        ? `
          <label class="interaction-option interaction-option-other">
            <input type="radio" name="${app.escapeHtml(id)}" value="__other__">
            <span>其他</span>
            <input class="interaction-other-input" type="${secret ? "password" : "text"}" data-other-for="${app.escapeHtml(id)}" autocomplete="off">
          </label>
        `
        : "";
      return `
        <div class="interaction-question" data-question-id="${app.escapeHtml(id)}">
          ${labelHtml}
          <div class="interaction-options">${optionHtml}${otherHtml}</div>
        </div>
      `;
    }

    return `
      <label class="interaction-question" data-question-id="${app.escapeHtml(id)}">
        ${labelHtml}
        <input class="interaction-text-input" name="${app.escapeHtml(id)}" type="${secret ? "password" : "text"}" autocomplete="off">
      </label>
    `;
  };

  app.submitInteractionAnswer = async function submitInteractionAnswer(sessionId, interaction, form) {
    const answers = app.collectInteractionAnswers(interaction, form);
    if (!answers) return;
    await app.decideInteraction(sessionId, interaction.id, { answers });
  };

  app.collectInteractionAnswers = function collectInteractionAnswers(interaction, form) {
    const answers = {};
    for (const question of app.interactionQuestions(interaction)) {
      const originalId = String(question.id || "answer").trim() || "answer";
      const fieldId = app.safeInteractionFieldId(originalId);
      const escapedFieldId = app.cssEscape(fieldId);
      const selected = form.querySelector(`input[type="radio"][name="${escapedFieldId}"]:checked`);
      let values = [];
      if (selected) {
        if (selected.value === "__other__") {
          const otherValue = form.querySelector(`[data-other-for="${escapedFieldId}"]`)?.value || "";
          values = [otherValue.trim()];
        } else {
          values = [selected.value];
        }
      } else {
        const input = form.querySelector(`[name="${escapedFieldId}"]`);
        values = [String(input?.value || "").trim()];
      }
      values = values.filter(Boolean);
      if (values.length === 0) {
        app.toast("请先完成 Codex 的选择");
        return null;
      }
      answers[originalId] = { answers: values };
    }
    return answers;
  };

  app.safeInteractionFieldId = function safeInteractionFieldId(value) {
    return String(value || "answer").trim().replace(/[^A-Za-z0-9_-]/g, "_") || "answer";
  };

  app.cssEscape = function cssEscape(value) {
    if (windowRef.CSS?.escape) return windowRef.CSS.escape(value);
    return String(value || "").replace(/["\\]/g, "\\$&");
  };

  app.decideInteraction = async function decideInteraction(sessionId, interactionId, payload) {
    try {
      await app.apiPost(`/api/codex/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}`, payload);
      app.toast(payload.decision === "cancel" ? "已取消" : "已提交");
      await app.showCodexJob(sessionId, { keepSelection: true });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    }
  };

  app.refreshTurnActivityLine = function refreshTurnActivityLine() {
    if (!elements.turnActivityLine || !elements.turnActivityText) return;
    if (!state.turnActivityDetailsOpen) {
      app.hideTurnActivityLine();
      return;
    }

    const activity = app.turnActivityForSession(state.composingNewSession ? null : state.selectedCodexSession);
    if (!activity) {
      state.turnActivityDetailsOpen = false;
      app.refreshTurnActivityToggle?.(state.composingNewSession ? null : state.selectedCodexSession);
      app.hideTurnActivityLine();
      return;
    }

    elements.turnActivityLine.hidden = false;
    elements.turnActivityLine.dataset.state = activity.state || "running";
    elements.turnActivityLine.title = activity.title || activity.text;
    elements.turnActivityText.textContent = activity.text;
    app.syncComposerMetrics?.();
  };

  app.runningSessionStatusText = function runningSessionStatusText(session) {
    const quietInfo = app.runningSessionQuietInfo(session);
    if (!quietInfo) return "Codex 正在处理";
    if (quietInfo.leaseExpired) return "运行状态待刷新";
    if (quietInfo.stale) return `Codex 运行中 · ${app.formatDurationShort(quietInfo.elapsedMs)}无新日志`;
    if (quietInfo.quiet) return "Codex 运行中 · 暂无新日志";
    return "Codex 正在处理";
  };

  app.runningSessionQuietInfo = function runningSessionQuietInfo(session) {
    if (!session || session.status !== "running") return null;
    const lastLogAtMs = app.sessionLastLoggedEventMs(session);
    if (!lastLogAtMs) return null;
    const now = Date.now();
    const elapsedMs = Math.max(0, now - lastLogAtMs);
    const leaseExpiresAtMs = app.timestampMs(session.leaseExpiresAt);
    return {
      elapsedMs,
      quiet: elapsedMs >= RUNNING_ACTIVITY_QUIET_MS,
      stale: elapsedMs >= RUNNING_ACTIVITY_STALE_MS,
      leaseExpired: Boolean(leaseExpiresAtMs && leaseExpiresAtMs < now)
    };
  };

  app.sessionLastLoggedEventMs = function sessionLastLoggedEventMs(session) {
    const candidates = [];
    if (session?.lastEvent?.at) candidates.push(session.lastEvent.at);
    if (session?.contextUsage?.at) candidates.push(session.contextUsage.at);
    for (const event of session?.events || []) {
      if (event?.at) candidates.push(event.at);
    }
    return candidates.reduce((latest, value) => Math.max(latest, app.timestampMs(value)), 0);
  };

  app.timestampMs = function timestampMs(value) {
    const time = new Date(value || "").getTime();
    return Number.isFinite(time) ? time : 0;
  };

  app.formatDurationShort = function formatDurationShort(ms) {
    const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
    if (seconds < 60) return "不到 1 分钟";
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.max(1, Math.round(minutes / 60));
    return `${hours} 小时`;
  };

  app.hideTurnActivityLine = function hideTurnActivityLine() {
    if (elements.turnActivityLine.hidden && !elements.turnActivityText.textContent && !elements.turnActivityLine.dataset.state) return;
    elements.turnActivityLine.hidden = true;
    elements.turnActivityLine.dataset.state = "";
    elements.turnActivityLine.removeAttribute("title");
    elements.turnActivityText.textContent = "";
    app.syncComposerMetrics?.();
  };

  app.toggleTurnActivityDetails = function toggleTurnActivityDetails() {
    const session = state.composingNewSession ? null : state.selectedCodexSession;
    if (!app.turnActivityAvailable(session)) return;
    state.turnActivityDetailsOpen = !state.turnActivityDetailsOpen;
    app.refreshTurnActivityToggle(session);
    app.refreshTurnActivityLine();
  };

  app.refreshTurnActivityToggle = function refreshTurnActivityToggle(session = null, status = "") {
    if (!elements.composerStatusText) return;
    const available = app.turnActivityAvailable(session);
    if (!available) state.turnActivityDetailsOpen = false;
    elements.composerStatusText.disabled = !available;
    elements.composerStatusText.classList.toggle("is-clickable", available);
    elements.composerStatusText.setAttribute("aria-expanded", available && state.turnActivityDetailsOpen ? "true" : "false");
    elements.composerStatusText.setAttribute("title", available ? "查看运行详情" : status || "");
  };

  app.turnActivityAvailable = function turnActivityAvailable(session) {
    return Boolean(
      session &&
        (["queued", "starting", "running"].includes(session.status) ||
          Number(session.pendingCommandCount || 0) > 0 ||
          Number(session.pendingApprovalCount || 0) > 0 ||
          Number(session.pendingInteractionCount || 0) > 0)
    );
  };

  app.turnActivityForSession = function turnActivityForSession(session) {
    if (!session) return null;
    if (!app.turnActivityAvailable(session)) return null;
    if (app.sessionCancelRequested(session)) {
      return { state: "queued", text: "正在中断", title: "取消请求已发送到桌面端" };
    }

    const commandActivity = app.latestCommandActivity(session.events || []);
    const quietInfo = app.runningSessionQuietInfo(session);
    if (commandActivity && !(quietInfo?.quiet && commandActivity.state === "completed")) return commandActivity;
    if (Number(session.pendingInteractionCount || 0) > 0) {
      return { state: "approval", text: "等待选择", title: "等待你回答 Codex 的结构化问题" };
    }
    if (Number(session.pendingApprovalCount || 0) > 0) {
      return { state: "approval", text: "等待审批", title: "等待你在手机上批准 Codex 请求" };
    }
    if (Number(session.pendingCommandCount || 0) > 0 || session.status === "queued") {
      return { state: "queued", text: "等待桌面接收任务", title: "任务已进入桌面端队列" };
    }
    if (session.status === "starting") {
      return { state: "running", text: "Codex 正在启动", title: "桌面端正在启动 Codex" };
    }
    if (session.status === "running") {
      if (quietInfo?.leaseExpired) {
        return {
          state: "queued",
          text: "运行状态待刷新",
          title: "relay 上的运行租约已经过期，正在等待状态刷新"
        };
      }
      if (quietInfo?.stale) {
        const age = app.formatDurationShort(quietInfo.elapsedMs);
        return {
          state: "queued",
          text: `Codex 运行中 · ${age}无新日志`,
          title: `最近一次 Codex 事件是 ${age}前。可能只是模型在思考，也可能需要中断后重试。`
        };
      }
      if (quietInfo?.quiet) {
        return {
          state: "queued",
          text: "Codex 运行中 · 暂无新日志",
          title: "Codex 仍在运行，但最近没有新的日志事件。"
        };
      }
      return { state: "running", text: "Codex 正在处理这一轮", title: "Codex 正在执行当前 turn" };
    }
    return null;
  };

  app.latestCommandActivity = function latestCommandActivity(events) {
    let latestOutput = "";
    for (const event of [...events].reverse()) {
      const raw = event.raw || {};
      const method = raw.method || event.type || "";
      const params = raw.params || {};

      if (app.isCommandOutputEvent(method)) {
        latestOutput ||= app.activityOutputSnippet(event.text || params.delta || "");
        continue;
      }

      if (method === "item/commandExecution/requestApproval") {
        const commandText = app.commandDisplayText(params.command);
        return {
          state: "approval",
          text: app.compactActivityText(`等待审批 ${commandText}`),
          title: commandText
        };
      }

      if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
        return {
          state: "approval",
          text: "等待选择",
          title: "Codex 正在等待你的选择"
        };
      }

      const item = params.item || {};
      if (item.type !== "commandExecution") continue;
      const commandText = app.commandDisplayText(item.command);
      const status = String(item.status || (method === "item/completed" ? "completed" : "running")).toLowerCase();
      const output = latestOutput || app.activityOutputSnippet(item.aggregatedOutput || "");
      const prefix = app.commandActivityPrefix(status, method);
      const text = output ? `${prefix} ${commandText} · ${output}` : `${prefix} ${commandText}`;
      return {
        state: app.commandActivityState(status, method),
        text: app.compactActivityText(text),
        title: output ? `${commandText}\n${output}` : commandText
      };
    }
    if (latestOutput) {
      return {
        state: "running",
        text: app.compactActivityText(`输出 ${latestOutput}`),
        title: latestOutput
      };
    }
    return null;
  };

  app.isCommandOutputEvent = function isCommandOutputEvent(method) {
    return method === "command/exec/outputDelta" || method === "item/commandExecution/outputDelta";
  };

  app.commandDisplayText = function commandDisplayText(command) {
    const text = Array.isArray(command) ? command.join(" ") : String(command || "后台命令");
    return app.compactActivityText(text.replace(/\s+/g, " ").trim() || "后台命令", 96);
  };

  app.commandActivityPrefix = function commandActivityPrefix(status, method) {
    if (status.includes("fail") || status.includes("error")) return "命令失败";
    if (status.includes("cancel")) return "已取消";
    if (status.includes("complete") || status.includes("success") || status.includes("succeed")) return "已完成";
    return method === "item/completed" ? "已完成" : "正在运行";
  };

  app.commandActivityState = function commandActivityState(status, method) {
    if (status.includes("fail") || status.includes("error")) return "failed";
    if (status.includes("cancel")) return "idle";
    if (status.includes("complete") || status.includes("success") || status.includes("succeed") || method === "item/completed") {
      return "completed";
    }
    return "running";
  };

  app.activityOutputSnippet = function activityOutputSnippet(value) {
    const lines = String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const latestLine = lines.at(-1) || "";
    return app.compactActivityText(app.redactActivityText(latestLine), 72);
  };

  app.redactActivityText = function redactActivityText(value) {
    return String(value || "").replace(/\b(token|secret|password|api[_-]?key)\b\s*[:=]\s*[^,\s]+/gi, "$1=***");
  };

  app.compactActivityText = function compactActivityText(value, limit = 140) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : text;
  };

  app.renderConversationThread = function renderConversationThread(job, errorText = "") {
    const timeline = app.buildConversationTimeline(job, errorText);
    return timeline.map(app.renderConversationEntry).join("");
  };

  app.sessionRenderSignature = function sessionRenderSignature(job, errorText = "", timeline = null) {
    const entries = timeline || app.buildConversationTimeline(job, errorText);
    return JSON.stringify({
      id: job.id || "",
      status: job.status || "",
      projectId: job.projectId || "",
      archivedAt: job.archivedAt || "",
      pendingApprovalCount: job.pendingApprovalCount || 0,
      pendingInteractionCount: job.pendingInteractionCount || 0,
      pendingUserInputCount: job.pendingUserInputCount || 0,
      pendingCommandCount: job.pendingCommandCount || 0,
      title: app.jobTitle(job),
      errorText,
      timeline: entries.map((entry) => ({
        kind: entry.kind || "",
        role: entry.role || "",
        text: entry.text || "",
        title: entry.title || "",
        body: entry.body || "",
        at: entry.at || "",
        draft: Boolean(entry.draft),
        attachments: (entry.attachments || []).map((attachment) => ({
          type: attachment?.type || "",
          name: attachment?.name || "",
          id: attachment?.id || "",
          downloadPath: attachment?.downloadPath || ""
        }))
      })),
      approvals: (job.approvals || []).map((approval) => ({
        id: approval.id || "",
        method: approval.method || "",
        prompt: approval.prompt || "",
        title: app.approvalTitle(approval),
        detail: app.approvalDetail(approval)
      })),
      interactions: (job.interactions || []).map((interaction) => ({
        id: interaction.id || "",
        method: interaction.method || "",
        kind: interaction.kind || "",
        prompt: interaction.prompt || "",
        status: interaction.status || "",
        questions: app.interactionQuestions(interaction).map((question) => ({
          id: question.id || "",
          header: question.header || "",
          question: question.question || "",
          isOther: Boolean(question.isOther || question.is_other),
          isSecret: Boolean(question.isSecret || question.is_secret),
          options: (question.options || []).map((option) => ({
            label: option.label || "",
            description: option.description || ""
          }))
        }))
      }))
    });
  };

  app.buildConversationTimeline = function buildConversationTimeline(job, errorText = "") {
    const timeline = [];
    const messages = Array.isArray(job.messages) ? job.messages : [];

    if (messages.length > 0) {
      const renderedAssistantKeys = new Set();
      const renderedAssistantTexts = new Set();
      for (const message of messages) {
        const text = String(message.text || "").trim();
        const attachments = app.messageAttachments(message);
        if (!text && attachments.length === 0) continue;
        if (message.role === "assistant") {
          if (message.externalKey) renderedAssistantKeys.add(message.externalKey);
          if (text) renderedAssistantTexts.add(text);
        }
        timeline.push({
          kind: "message",
          role: message.role === "assistant" ? "assistant" : "user",
          text,
          attachments,
          at: message.createdAt || job.updatedAt || job.createdAt || ""
        });
      }

      for (const event of job.events || []) {
        const assistantEntry = app.assistantMessageEntryFromEvent(event);
        if (!assistantEntry?.text) continue;
        if (assistantEntry.externalKey && renderedAssistantKeys.has(assistantEntry.externalKey)) continue;
        if (!assistantEntry.externalKey && renderedAssistantTexts.has(assistantEntry.text)) continue;
        if (app.lastTimelineMessageText(timeline, "assistant") === assistantEntry.text) continue;
        if (assistantEntry.externalKey) renderedAssistantKeys.add(assistantEntry.externalKey);
        renderedAssistantTexts.add(assistantEntry.text);
        timeline.push(assistantEntry);
      }
    } else {
      const events = Array.isArray(job.events) ? job.events : [];

      for (const event of events) {
        const userText = event.type === "user.message" ? String(event.text || "").trim() : "";
        const userAttachments = event.type === "user.message" ? app.userMessageAttachments(event) : [];
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

        const assistantText = app.assistantMessageText(event);
        if (!assistantText) continue;
        if (app.lastTimelineMessageText(timeline, "assistant") === assistantText) continue;
        timeline.push({
          kind: "message",
          role: "assistant",
          text: assistantText,
          at: event.at || job.updatedAt || ""
        });
      }
    }

    app.appendOperationalTimelineEntries(timeline, job);
    app.sortTimelineEntries(timeline);

    const draftAssistantText = app.activeAssistantDraft(job, timeline);
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
  };

  app.appendOperationalTimelineEntries = function appendOperationalTimelineEntries(timeline, job) {
    const seenPlans = new Set(timeline.filter((entry) => entry.kind === "plan").map((entry) => entry.text));
    const seenSystem = new Set();
    const seenTests = new Set();
    const latestPlanByTurn = new Map();

    for (const event of job.events || []) {
      const plan = app.planEntryFromEvent(event);
      if (plan?.text) latestPlanByTurn.set(plan.turnId || plan.text, plan);
    }

    for (const plan of latestPlanByTurn.values()) {
      if (seenPlans.has(plan.text)) continue;
      seenPlans.add(plan.text);
      timeline.push({
        kind: "plan",
        text: plan.text,
        at: plan.at
      });
    }

    for (const event of job.events || []) {
      const system = app.compactionEntryFromEvent(event);
      if (!system?.text || seenSystem.has(system.text)) continue;
      seenSystem.add(system.text);
      timeline.push(system);
    }

    for (const event of job.events || []) {
      const testSummary = app.testSummaryEntryFromEvent(event);
      if (!testSummary?.command) continue;
      const key = [testSummary.turnId, testSummary.command, testSummary.status, testSummary.at].join("\u001f");
      if (seenTests.has(key)) continue;
      seenTests.add(key);
      timeline.push(testSummary);
    }
  };

  app.sortTimelineEntries = function sortTimelineEntries(timeline) {
    timeline.sort((a, b) => {
      const left = Date.parse(a.at || "");
      const right = Date.parse(b.at || "");
      if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
      if (!Number.isFinite(left)) return 1;
      if (!Number.isFinite(right)) return -1;
      return left - right;
    });
  };

  app.planEntryFromEvent = function planEntryFromEvent(event) {
    const raw = event.raw || {};
    const item = raw.params?.item;
    if (event.type === "item/completed" && item?.type === "plan") {
      return {
        text: String(item.text || event.text || "").trim(),
        turnId: String(raw.params?.turnId || raw.params?.turn?.id || item.id || "").trim(),
        at: event.at || ""
      };
    }
    if (event.type === "turn/plan/updated") {
      return {
        text: String(event.text || "").trim(),
        turnId: String(raw.params?.turnId || raw.params?.turn?.id || "").trim(),
        at: event.at || ""
      };
    }
    return null;
  };

  app.compactionEntryFromEvent = function compactionEntryFromEvent(event) {
    const itemType = event.raw?.params?.item?.type || "";
    if (event.type === "plan.mode.fallback") {
      return { kind: "system", text: "计划模式已降级为兼容指令", at: event.at || "" };
    }
    if (event.type === "context.compaction.queued") {
      return { kind: "system", text: "上下文压缩已排队", at: event.at || "" };
    }
    if (event.type === "context.compaction.started") {
      return { kind: "system", text: "上下文压缩中", at: event.at || "" };
    }
    if (event.type === "thread/compacted") {
      return { kind: "system", text: "上下文已压缩", at: event.at || "" };
    }
    if (itemType === "contextCompaction") {
      return { kind: "system", text: "上下文已压缩", at: event.at || "" };
    }
    return null;
  };

  app.testSummaryEntryFromEvent = function testSummaryEntryFromEvent(event) {
    const raw = event.raw || {};
    const summary = raw.testSummary || {};
    if (event.type !== "test.summary" && raw.method !== "test.summary") return null;
    const command = String(summary.command || "").trim();
    if (!command) return null;
    const failures = Array.isArray(summary.failures) ? summary.failures.map((line) => String(line || "").trim()).filter(Boolean) : [];
    const status = String(summary.status || "").trim() || "completed";
    const level = String(summary.level || "").trim() || "quick";
    const outputArtifact = summary.outputArtifact && typeof summary.outputArtifact === "object" ? summary.outputArtifact : null;
    const lines = [`${app.testLevelLabel(level)} · ${app.testStatusLabel(status)}`, command, ...failures.slice(0, 5)];
    if (outputArtifact?.downloadPath) lines.push(outputArtifact.downloadPath);
    return {
      kind: "test",
      text: lines.filter(Boolean).join("\n"),
      level,
      status,
      command,
      failures,
      outputArtifact,
      turnId: String(summary.turnId || "").trim(),
      at: event.at || ""
    };
  };

  app.testLevelLabel = function testLevelLabel(level) {
    return {
      quick: "快速检查",
      integration: "集成检查",
      "browser-smoke": "浏览器冒烟",
      e2e: "E2E"
    }[level] || "检查";
  };

  app.testStatusLabel = function testStatusLabel(status) {
    const normalized = String(status || "").toLowerCase();
    if (normalized === "passed") return "通过";
    if (normalized === "failed") return "失败";
    if (normalized === "cancelled") return "已取消";
    return status || "完成";
  };

  app.toggleContextUsageDetails = function toggleContextUsageDetails() {
    const session = state.composingNewSession ? null : state.selectedCodexSession;
    if (!session?.id) return;
    state.contextUsageDetailsOpen = !state.contextUsageDetailsOpen;
    app.refreshContextUsageIndicator?.();
  };

  app.refreshContextUsageDetails = function refreshContextUsageDetails() {
    const line = elements.contextUsageDetailsLine;
    if (!line) return;

    const session = state.composingNewSession ? null : state.selectedCodexSession;
    const entry = app.contextUsageDetailsEntry(session);
    if (!state.contextUsageDetailsOpen || !entry) {
      if (line.hidden && !line.innerHTML && !line.dataset.state) return;
      line.hidden = true;
      line.innerHTML = "";
      line.dataset.state = "";
      line.removeAttribute("title");
      app.syncComposerMetrics?.();
      return;
    }

    line.hidden = false;
    line.dataset.state = entry.state || "normal";
    line.title = entry.title || entry.primary;
    line.innerHTML = `
      <span class="context-usage-details-primary">${app.escapeHtml(entry.primary)}</span>
      <span class="context-usage-details-secondary">
        ${entry.parts.map((part) => `<span class="context-usage-detail-pill">${app.escapeHtml(part)}</span>`).join("")}
      </span>
    `;
    app.syncComposerMetrics?.();
  };

  app.contextUsageDetailsEntry = function contextUsageDetailsEntry(session) {
    if (!session?.id) return null;

    const usage = app.normalizeContextUsage(session.contextUsage) || app.latestContextUsageFromEvents(session.events || []);
    const contextPercent = app.currentContextPercentForSession(session);
    const eventCount = app.sessionEventCount(session);
    const artifactBytes = app.sessionArtifactBytes(session);
    const risk = app.sessionRiskLevel({ contextPercent, eventCount, artifactBytes });
    const primary = app.contextUsagePrimaryLabel(usage, contextPercent);
    const parts = [];

    if (usage?.inputTokens) parts.push(`输入 ${app.formatTokenCount(usage.inputTokens)}`);
    if (usage?.cachedInputTokens) parts.push(`缓存 ${app.formatTokenCount(usage.cachedInputTokens)}`);
    if (usage?.outputTokens) parts.push(`输出 ${app.formatTokenCount(usage.outputTokens)}`);
    if (usage?.reasoningOutputTokens) parts.push(`推理 ${app.formatTokenCount(usage.reasoningOutputTokens)}`);
    if (Number.isFinite(eventCount)) parts.push(`${eventCount.toLocaleString("zh-CN")} 事件`);
    const streamLabel = app.sessionStreamStatusLabel(session);
    if (streamLabel) parts.push(`事件流 ${streamLabel}`);
    if (artifactBytes > 0) parts.push(`产物 ${app.formatBytes(artifactBytes)}`);
    const updatedAt = usage?.at || session.lastEvent?.at || "";
    if (updatedAt) parts.push(`更新 ${app.formatRelativeTime(updatedAt)}`);

    return {
      state: risk === "high" ? "risk" : risk === "warn" ? "warn" : "normal",
      primary,
      parts,
      title: [primary, ...parts].filter(Boolean).join("\n")
    };
  };

  app.contextUsagePrimaryLabel = function contextUsagePrimaryLabel(usage, contextPercent) {
    if (!usage) return "上下文暂未同步";
    const used = app.formatTokenCount(usage.usedTokens);
    if (usage.limitTokens > 0 && Number.isFinite(contextPercent)) {
      return `上下文 ${contextPercent}% · ${used} / ${app.formatTokenCount(usage.limitTokens)} tokens`;
    }
    return `上下文已同步 · ${used} tokens · 模型窗口未知`;
  };

  app.sessionEventCount = function sessionEventCount(session) {
    const count = Number(session?.metrics?.eventCount ?? session?.eventCount);
    if (Number.isFinite(count) && count >= 0) return count;
    return Array.isArray(session?.events) ? session.events.length : 0;
  };

  app.sessionArtifactBytes = function sessionArtifactBytes(session) {
    const bytes = Number(session?.metrics?.artifactBytes ?? session?.artifactBytes ?? 0);
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  };

  app.sessionStreamStatusLabel = function sessionStreamStatusLabel(session) {
    if (!session?.id || session.id !== state.selectedCodexJobId) return "";
    if (!windowRef.EventSource) return "轮询回退";
    if (state.sessionEventSourceId === session.id && state.sessionEventSource) {
      const readyState = Number(state.sessionEventSource.readyState);
      if (readyState === 1) return "SSE 实时";
      if (readyState === 0) return "SSE 连接中";
      return "SSE 重连中";
    }
    if (state.sessionEventReconnectTimer) return "SSE 重连中";
    return "轮询回退";
  };

  app.formatTokenCount = function formatTokenCount(value) {
    const count = Number(value || 0);
    return Number.isFinite(count) ? count.toLocaleString("zh-CN") : "0";
  };

  app.renderSessionStatusRail = function renderSessionStatusRail(session) {
    const rail = elements.sessionStatusRail;
    if (!rail) return;

    const entry = app.sessionStatusRailEntry(session);
    if (!entry) {
      rail.hidden = true;
      rail.innerHTML = "";
      rail.removeAttribute("title");
      rail.dataset.mode = "";
      rail.dataset.gitState = "";
      return;
    }

    rail.hidden = false;
    rail.dataset.mode = entry.mode;
    rail.dataset.gitState = entry.gitState;
    rail.title = entry.title;
    rail.innerHTML = `
      <span class="session-status-dot" aria-hidden="true"></span>
      <span class="session-status-mode">${app.escapeHtml(entry.modeLabel)}</span>
      <span class="session-status-git">${app.escapeHtml(entry.gitLabel)}</span>
      ${entry.healthLabel ? `<span class="session-status-health">${app.escapeHtml(entry.healthLabel)}</span>` : ""}
      ${entry.refText ? `<span class="session-status-ref">${app.escapeHtml(entry.refText)}</span>` : ""}
    `;
  };

  app.sessionStatusRailEntry = function sessionStatusRailEntry(session) {
    if (!session?.id) return null;

    const execution = session.execution || {};
    const latestGitEvent = app.latestGitSummaryEvent(session.events || []);
    const summary = latestGitEvent?.raw?.gitSummary || {};
    const inWorktree = execution.mode === "worktree";
    if (!inWorktree && !latestGitEvent) return null;

    const changedFiles = Array.isArray(summary.changedFiles) ? summary.changedFiles : null;
    const changedFileCount = Number.isFinite(Number(summary.changedFileCount))
      ? Number(summary.changedFileCount)
      : changedFiles
        ? changedFiles.length
        : null;
    const branch = String(summary.branch || execution.branchName || "").trim();
    const commit = app.shortCommit(summary.commit || execution.baseCommit || "");
    const refText = [branch, commit].filter(Boolean).join(" @ ");
    const gitLabel = Number.isFinite(changedFileCount)
      ? changedFileCount > 0
        ? `Git 变更 ${changedFileCount}`
        : "Git 无变更"
      : app.sessionStatusGitPendingLabel(session);
    const modeLabel = inWorktree ? "隔离 worktree" : "主工作区";
    const title = [modeLabel, refText, execution.path || summary.root || ""].filter(Boolean).join("\n");

    return {
      mode: inWorktree ? "worktree" : "workspace",
      gitState: Number.isFinite(changedFileCount) && changedFileCount > 0 ? "dirty" : Number.isFinite(changedFileCount) ? "clean" : "pending",
      modeLabel,
      gitLabel,
      healthLabel: "",
      refText,
      title
    };
  };

  app.sessionHealthEntry = function sessionHealthEntry(session) {
    const metrics = session?.metrics || {};
    const contextPercent = Number(metrics.contextPercent ?? app.currentContextPercentForSession(session));
    const eventCount = Number(metrics.eventCount ?? session?.eventCount ?? 0);
    const artifactBytes = Number(metrics.artifactBytes ?? session?.artifactBytes ?? 0);
    const risk = metrics.risk || app.sessionRiskLevel({ contextPercent, eventCount, artifactBytes });
    if (risk === "normal" && !Number.isFinite(contextPercent) && eventCount < 80 && artifactBytes < 512 * 1024) return null;
    const parts = [];
    if (Number.isFinite(contextPercent)) parts.push(`上下文 ${contextPercent}%`);
    if (eventCount >= 80) parts.push(`${eventCount} 事件`);
    if (artifactBytes > 0) parts.push(app.formatBytes(artifactBytes));
    const label = parts.slice(0, 2).join(" · ") || (risk === "high" ? "会话很长" : "会话偏长");
    return {
      state: risk === "high" ? "risk" : risk === "warn" ? "pending" : "",
      label,
      title: [`会话负载：${risk}`, ...parts].filter(Boolean).join("\n")
    };
  };

  app.currentContextPercentForSession = function currentContextPercentForSession(session) {
    const usage = app.normalizeContextUsage(session?.contextUsage) || app.latestContextUsageFromEvents(session?.events || []);
    if (!usage?.limitTokens || !usage.usedTokens) return null;
    return Math.max(0, Math.min(100, Math.round((usage.usedTokens / usage.limitTokens) * 100)));
  };

  app.sessionRiskLevel = function sessionRiskLevel({ contextPercent = null, eventCount = 0, artifactBytes = 0 } = {}) {
    if (Number(contextPercent) >= 85 || Number(eventCount) >= 160 || Number(artifactBytes) >= 2 * 1024 * 1024) return "high";
    if (Number(contextPercent) >= 70 || Number(eventCount) >= 100 || Number(artifactBytes) >= 768 * 1024) return "warn";
    return "normal";
  };

  app.formatBytes = function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  };

  app.latestGitSummaryEvent = function latestGitSummaryEvent(events) {
    return [...(events || [])].reverse().find((event) => event.type === "git.summary") || null;
  };

  app.sessionStatusGitPendingLabel = function sessionStatusGitPendingLabel(session) {
    if (["queued", "starting", "running"].includes(session.status)) return "运行中";
    return "Git 待更新";
  };

  app.shortCommit = function shortCommit(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return text.length > 12 ? text.slice(0, 7) : text;
  };

  app.renderConversationEntry = function renderConversationEntry(entry) {
    if (entry.kind === "error") {
      return `
        <article class="thread-message thread-message-system">
          <div class="thread-bubble thread-bubble-error">${app.escapeHtml(entry.text)}</div>
        </article>
      `;
    }

    if (entry.kind === "empty") {
      return `
        <div class="thread-welcome">
          <strong>${app.escapeHtml(entry.title)}</strong>
          <p>${app.escapeHtml(entry.body)}</p>
        </div>
      `;
    }

    if (entry.kind === "system") {
      return `
        <div class="thread-status-row">
          <span class="thread-status-pill">${app.escapeHtml(entry.text)}</span>
        </div>
      `;
    }

    if (entry.kind === "plan") {
      return `
        <article class="thread-message thread-message-system">
          <div class="thread-plan-card">
            <div class="thread-plan-card-head">
              <span class="thread-status-pill">计划</span>
              ${entry.at ? `<span class="thread-message-time">${app.escapeHtml(app.formatMessageTime(entry.at))}</span>` : ""}
            </div>
            <div class="thread-plan-card-body">${app.escapeHtml(entry.text)}</div>
          </div>
        </article>
      `;
    }

    if (entry.kind === "test") {
      const statusClass = entry.status === "failed" ? "warn" : "";
      const artifact = entry.outputArtifact || {};
      return `
        <article class="thread-message thread-message-system">
          <div class="thread-plan-card thread-test-card">
            <div class="thread-plan-card-head">
              <span class="thread-status-pill">${app.escapeHtml(app.testLevelLabel(entry.level))}</span>
              <span class="thread-status-pill ${app.escapeHtml(statusClass)}">${app.escapeHtml(app.testStatusLabel(entry.status))}</span>
              ${entry.at ? `<span class="thread-message-time">${app.escapeHtml(app.formatMessageTime(entry.at))}</span>` : ""}
            </div>
            <div class="thread-test-command">${app.escapeHtml(entry.command)}</div>
            ${
              entry.failures?.length
                ? `<div class="thread-test-failures">${entry.failures
                    .slice(0, 5)
                    .map((failure) => `<span>${app.escapeHtml(failure)}</span>`)
                    .join("")}</div>`
                : ""
            }
            ${
              artifact.downloadPath
                ? `<a class="thread-test-artifact" href="${app.escapeHtml(artifact.downloadPath)}" target="_blank" rel="noreferrer">${app.escapeHtml(
                    artifact.label || "完整输出"
                  )}</a>`
                : ""
            }
          </div>
        </article>
      `;
    }

    const roleLabel = entry.role === "user" ? "你" : "Codex";
    const roleClass = entry.role === "user" ? "thread-message-user" : "thread-message-assistant";
    const bubbleClass = entry.role === "user" ? "thread-bubble-user" : "thread-bubble-assistant";
    const draftBadge = entry.draft ? '<span class="thread-draft-badge">回复中</span>' : "";
    const timeLabel = entry.at ? app.formatMessageTime(entry.at) : "";
    const attachmentsHtml = app.renderConversationAttachments(entry.attachments || []);
    const actionsHtml = entry.text ? app.renderConversationActions() : "";

    return `
      <article class="thread-message ${roleClass}">
        <div class="thread-message-meta">
          <span class="thread-message-role">${roleLabel}</span>
          ${draftBadge}
          ${timeLabel ? `<span class="thread-message-time">${app.escapeHtml(timeLabel)}</span>` : ""}
        </div>
        ${entry.text ? `<div class="thread-bubble ${bubbleClass}">${app.escapeHtml(entry.text)}</div>` : ""}
        ${attachmentsHtml}
        ${actionsHtml}
      </article>
    `;
  };

  app.renderConversationActions = function renderConversationActions() {
    return `
      <div class="thread-message-actions" aria-label="消息操作">
        <button class="thread-message-action" type="button" data-thread-action="copy" aria-label="复制消息" title="复制">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 7.5A2.5 2.5 0 0 1 10.5 5h6A2.5 2.5 0 0 1 19 7.5v6A2.5 2.5 0 0 1 16.5 16h-6A2.5 2.5 0 0 1 8 13.5v-6Z" />
            <path d="M6 8.5v7A2.5 2.5 0 0 0 8.5 18h7" />
          </svg>
        </button>
        <button class="thread-message-action" type="button" data-thread-action="edit" aria-label="重新编辑消息" title="重新编辑">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 18.5 6.1 14l8.8-8.8a2.1 2.1 0 0 1 3 3L9.1 17 5 18.5Z" />
            <path d="m13.5 6.6 3 3" />
          </svg>
        </button>
      </div>
    `;
  };

  app.handleConversationAction = function handleConversationAction(event) {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest("[data-thread-action]");
    if (!button || !elements.codexRunSummary.contains(button)) return;

    const message = button.closest(".thread-message");
    const text = message?.querySelector(".thread-bubble")?.textContent || "";
    if (!text) return;

    event.preventDefault();
    const action = button.dataset.threadAction;
    if (action === "copy") {
      app
        .copyTextToClipboard(text)
        .then(() => app.toast("已复制"))
        .catch(() => app.toast("复制失败，请长按选择文本"));
      return;
    }
    if (action === "edit") {
      app.editConversationText(text);
    }
  };

  app.copyTextToClipboard = async function copyTextToClipboard(text) {
    const value = String(text || "");
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
    } catch {}
    if (!app.fallbackCopyText(value)) {
      throw new Error("Clipboard write failed.");
    }
  };

  app.fallbackCopyText = function fallbackCopyText(text) {
    const activeElement = document.activeElement;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    textarea.remove();
    activeElement?.focus?.({ preventScroll: true });
    return copied;
  };

  app.editConversationText = function editConversationText(text) {
    const value = String(text || "");
    elements.codexPrompt.value = value;
    app.syncComposerInputHeight();
    app.updateComposerAvailability();
    elements.codexPrompt.focus({ preventScroll: true });
    try {
      elements.codexPrompt.setSelectionRange(value.length, value.length);
    } catch {}
    app.toast("已放入输入框，可继续编辑");
  };

  app.assistantMessageText = function assistantMessageText(event) {
    const item = event.raw?.params?.item;
    if (event.type === "item/completed" && item?.type === "agentMessage") {
      return String(item.text || event.text || "").trim();
    }
    return "";
  };

  app.assistantMessageEntryFromEvent = function assistantMessageEntryFromEvent(event) {
    const text = app.assistantMessageText(event);
    if (!text) return null;
    return {
      kind: "message",
      role: "assistant",
      text,
      at: event.at || "",
      externalKey: app.assistantMessageExternalKey(event)
    };
  };

  app.assistantMessageExternalKey = function assistantMessageExternalKey(event) {
    const raw = event?.raw || {};
    const params = raw.params || {};
    const item = params.item || {};
    if ((raw.method || event?.type) !== "item/completed" || item.type !== "agentMessage") return "";
    const turnId = String(params.turnId || params.turn?.id || "").trim() || "turn";
    const itemId = String(item.id || "").trim();
    return itemId ? `assistant:${turnId}:${itemId}` : "";
  };

  app.activeAssistantDraft = function activeAssistantDraft(job, timeline) {
    const streamedDraft = app.activeAssistantDraftFromEvents(job.events || []);
    if (streamedDraft && app.lastTimelineMessageText(timeline, "assistant") !== streamedDraft) return streamedDraft;
    const current = String(job.finalMessage || "").trim();
    if (!current) return "";
    if (app.lastTimelineMessageText(timeline, "assistant") === current) return "";
    return current;
  };

  app.activeAssistantDraftFromEvents = function activeAssistantDraftFromEvents(events) {
    const drafts = new Map();
    const completed = new Set();

    for (const event of events || []) {
      const raw = event.raw || {};
      const method = raw.method || event.type || "";
      if (method === "item/completed" && raw.params?.item?.type === "agentMessage") {
        const key = app.assistantEventItemKey(event);
        if (key) {
          completed.add(key);
          drafts.delete(key);
        }
        continue;
      }
      if (method !== "item/agentMessage/delta") continue;
      const key = app.assistantEventItemKey(event);
      if (!key || completed.has(key)) continue;
      const delta = String(event.text || "");
      if (!delta) continue;
      drafts.set(key, `${drafts.get(key) || ""}${delta}`);
    }

    const latest = Array.from(drafts.values()).filter(Boolean).at(-1) || "";
    return latest.trim();
  };

  app.assistantEventItemKey = function assistantEventItemKey(event) {
    const params = event?.raw?.params || {};
    const item = params.item || {};
    const threadId = String(params.threadId || "").trim();
    const turnId = String(params.turnId || params.turn?.id || "").trim();
    const itemId = String(params.itemId || item.id || "").trim();
    if (!threadId && !turnId && !itemId) return "";
    return [threadId, turnId, itemId].join("\u001f");
  };

  app.lastTimelineMessageText = function lastTimelineMessageText(timeline, role) {
    const item = [...timeline].reverse().find((entry) => entry.kind === "message" && entry.role === role);
    return item?.text || "";
  };

  app.userMessageAttachments = function userMessageAttachments(event) {
    const attachments = Array.isArray(event.raw?.attachments) ? event.raw.attachments : [];
    return attachments.filter((attachment) => attachment?.type === "image");
  };

  app.messageAttachments = function messageAttachments(message) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    return attachments.filter((attachment) => attachment?.type === "image");
  };

  app.renderConversationAttachments = function renderConversationAttachments(attachments = []) {
    if (!attachments.length) return "";
    return `
      <div class="thread-attachments">
        ${attachments
          .map((attachment, index) => {
            const label = app.attachmentDisplayLabel(attachment, index);
            return `
              <div class="thread-attachment-pill">
                <span class="thread-attachment-pill-label">${app.escapeHtml(label)}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  };

  app.attachmentDisplayLabel = function attachmentDisplayLabel(attachment, index = 0) {
    const name = String(attachment?.name || "").trim();
    return name || `截图 ${index + 1}`;
  };

  app.jobPreview = function jobPreview(job) {
    const error = job.error || job.lastError || "";
    if (error) return app.humanizeCodexError(error).split("\n")[0].slice(0, 140);
    if (job.finalMessage) return job.finalMessage.slice(0, 140);
    return app.sessionPrompt(job).slice(0, 140);
  };

  app.jobTitle = function jobTitle(job) {
    return app.compactSessionTitle(app.sessionPrompt(job) || job.title || "Codex 会话");
  };

  app.sessionPrompt = function sessionPrompt(session) {
    const userMessage = (session.messages || []).find((message) => message.role === "user" && String(message.text || "").trim());
    if (userMessage) return userMessage.text;
    const userEvent = (session.events || []).find((event) => event.type === "user.message");
    return userEvent?.text || session.title || "";
  };

  app.compactSessionTitle = function compactSessionTitle(value) {
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .replace(/没有办法|没办法/g, "无法")
      .replace(/上下滑动/g, "上下滚动")
      .replace(/这个|那个/g, "")
      .trim();
    if (!normalized) return "Codex 会话";

    const sentence =
      normalized
        .split(/[\r\n]+|[。！？!?；;]/)
        .map((part) => part.trim())
        .find(Boolean) || normalized;

    const clause = app.firstTitleClause(sentence) || sentence;
    const cleaned = clause.replace(/^(?:现在|目前|帮我|麻烦|请你|请|顺手|另外|还有|然后|再)\s*/u, "").trim();
    return app.truncateSessionTitle(cleaned || sentence || normalized);
  };

  app.firstTitleClause = function firstTitleClause(text) {
    const separators = [/但是|不过|然后|另外|还有|顺手|同时|并且|而且|以及/u, /[，,：:]/u];
    for (const separator of separators) {
      const match = text.match(separator);
      if (match?.index > 6) return text.slice(0, match.index).trim();
    }
    return text.trim();
  };

  app.truncateSessionTitle = function truncateSessionTitle(text) {
    const compact = String(text || "").trim();
    if (!compact) return "Codex 会话";
    return compact.length > 28 ? `${compact.slice(0, 28).trimEnd()}…` : compact;
  };

  app.sessionTime = function sessionTime(session) {
    if (session?.status === "running") {
      const lastLoggedEventMs = app.sessionLastLoggedEventMs?.(session);
      if (lastLoggedEventMs) return new Date(lastLoggedEventMs).toISOString();
    }
    return session.updatedAt || session.completedAt || session.startedAt || session.createdAt;
  };

  app.refreshActiveSessionHeader = function refreshActiveSessionHeader() {
    const session = state.composingNewSession ? null : state.selectedCodexSession;
    const runtime = app.currentRuntimeDraft();
    const parts = [];
    const runtimeLabel = app.sessionRuntimeLabel(runtime);
    if (runtimeLabel) parts.push(runtimeLabel);
    if (session) {
      parts.push(session.archivedAt ? "已归档" : app.statusLabel(session.status));
      parts.push(app.formatRelativeTime(app.sessionTime(session)));
    }
    elements.activeSessionMeta.textContent = parts.filter(Boolean).join(" · ") || "选择权限、模型和推理强度后直接发送。";
    app.refreshComposerMeta();
    app.refreshComposerStatusBar();
    app.updateStopButton?.();
  };

  app.refreshComposerMeta = function refreshComposerMeta() {
    if (!elements.composerActionsMeta) return;
    if (state.composerBusy) {
      elements.composerActionsMeta.textContent = "Codex 正在处理这一轮消息。";
      return;
    }
    if (!elements.codexProject.value) {
      elements.composerActionsMeta.textContent = "先在左侧选择工程，再开始对话。";
      return;
    }
    const session = state.composingNewSession ? null : state.selectedCodexSession;
    const runtime = app.currentRuntimeDraft();
    const runtimeLabel = app.sessionRuntimeLabel(runtime) || "桌面默认";
    if (session && !app.sessionCanAcceptFollowUp(session)) {
      elements.composerActionsMeta.textContent = `当前会话不可继续，请先从左上角新建会话 · ${runtimeLabel}`;
      return;
    }
    const health = app.sessionHealthEntry(session);
    if (health?.state === "risk") {
      const memoryHint = app.canCompactSelectedSession(session) ? "可先压缩上下文" : "可手动新建话题";
      elements.composerActionsMeta.textContent = `会话较长 · ${memoryHint} · ${app.sessionProjectLabel(session?.projectId || elements.codexProject.value)} · ${runtimeLabel}`;
      return;
    }
    const lead = session ? (app.sessionHasPendingWork(session) ? "继续当前话题，接在这一轮后面" : "继续当前话题") : "发送后创建新话题";
    elements.composerActionsMeta.textContent = `${lead} · ${app.sessionProjectLabel(session?.projectId || elements.codexProject.value)} · ${runtimeLabel}`;
  };
}
