export function installSessions(app) {
  const { elements, state } = app;

  app.loadCodexJobs = async function loadCodexJobs() {
    const data = await app.apiGet(`/api/codex/sessions?archived=${state.showArchivedSessions ? "true" : "false"}`);
    const jobs = data.items.slice(0, 30);
    elements.codexJobs.innerHTML = "";
    if (jobs.length === 0) {
      const emptyCopy = state.showArchivedSessions ? "还没有归档会话" : "还没有 Codex 会话";
      elements.codexJobs.innerHTML = `<div class="empty-state">${app.escapeHtml(emptyCopy)}</div>`;
      state.selectedCodexSession = null;
      if (!state.composingNewSession) {
        state.selectedCodexJobId = "";
        app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
        app.renderEmptySessionDetail({
          title: state.showArchivedSessions ? "归档" : "新会话",
          body: state.showArchivedSessions ? "这里暂时没有归档会话。" : "直接发送，开始新的 Codex 会话。"
        });
      }
      return;
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
      await app.showCodexJob(state.selectedCodexJobId, { keepSelection: true });
      return;
    }

    state.selectedCodexSession = null;
    app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
    app.renderEmptySessionDetail({ title: "新会话", body: "直接发送，开始新的 Codex 会话。" });
  };

  app.renderSessionButton = function renderSessionButton(job) {
    const item = document.createElement("div");
    item.dataset.jobId = job.id;
    item.className = "conversation-item";
    item.classList.toggle("active", job.id === state.selectedCodexJobId);
    const archived = Boolean(job.archivedAt);
    const canArchive = !["queued", "starting", "running"].includes(job.status) && !job.pendingApprovalCount && !job.pendingCommandCount;
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
        ${job.pendingApprovalCount ? `<span class="conversation-item-alert">${app.escapeHtml(job.pendingApprovalCount)} 个待审批</span>` : ""}
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

  app.preferredSession = function preferredSession(jobs) {
    return (
      jobs.find((job) => job.pendingApprovalCount > 0) ||
      jobs.find((job) => ["queued", "starting", "running"].includes(job.status)) ||
      jobs.find((job) => job.status === "active") ||
      jobs[0]
    );
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
    const previousSessionId = state.selectedCodexJobId;
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
    const job = data.session;
    state.selectedCodexSession = job;
    if (!(options.keepSelection && state.runtimeDirty)) {
      app.applyRuntimeDraft(job.runtime || state.runtimePreferences, { persist: false, dirty: false });
    }
    const errorText = app.humanizeCodexError(job.error || job.lastError);
    elements.codexJobDetail.hidden = false;
    elements.runLog.hidden = false;
    elements.activeSessionTitle.textContent = app.jobTitle(job);
    elements.codexRunSummary.innerHTML = `
      <div class="conversation-thread">
        ${app.renderConversationThread(job, errorText)}
      </div>
    `;
    app.renderApprovals(job);
    const lines = [
      `# ${job.status} · ${job.projectId}`,
      errorText ? `ERROR: ${errorText}` : "",
      job.finalMessage ? `\nFinal:\n${job.finalMessage}` : "",
      "\nEvents:",
      ...(job.events || []).slice(-80).map((event) => `${event.at || ""} ${event.type || ""}\n${event.text || ""}`)
    ].filter(Boolean);
    elements.codexLog.textContent = lines.join("\n\n");
    app.refreshActiveSessionHeader();
    app.updateComposerAvailability();
    app.resetTopbarScrollTracking({ forceVisible: true });
  };

  app.renderEmptySessionDetail = function renderEmptySessionDetail({ title, body }) {
    elements.codexJobDetail.hidden = false;
    elements.activeSessionTitle.textContent = title;
    elements.codexApprovals.hidden = true;
    elements.codexApprovals.innerHTML = "";
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
    app.resetTopbarScrollTracking({ forceVisible: true });
  };

  app.renderApprovals = function renderApprovals(session) {
    const approvals = session.approvals || [];
    elements.codexApprovals.hidden = approvals.length === 0;
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

  app.renderConversationThread = function renderConversationThread(job, errorText = "") {
    const timeline = app.buildConversationTimeline(job, errorText);
    return timeline.map(app.renderConversationEntry).join("");
  };

  app.buildConversationTimeline = function buildConversationTimeline(job, errorText = "") {
    const timeline = [];
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

    const roleLabel = entry.role === "user" ? "你" : "Codex";
    const roleClass = entry.role === "user" ? "thread-message-user" : "thread-message-assistant";
    const bubbleClass = entry.role === "user" ? "thread-bubble-user" : "thread-bubble-assistant";
    const draftBadge = entry.draft ? '<span class="thread-draft-badge">回复中</span>' : "";
    const timeLabel = entry.at ? app.formatMessageTime(entry.at) : "";
    const attachmentsHtml = app.renderConversationAttachments(entry.attachments || []);

    return `
      <article class="thread-message ${roleClass}">
        <div class="thread-message-meta">
          <span class="thread-message-role">${roleLabel}</span>
          ${draftBadge}
          ${timeLabel ? `<span class="thread-message-time">${app.escapeHtml(timeLabel)}</span>` : ""}
        </div>
        ${entry.text ? `<div class="thread-bubble ${bubbleClass}">${app.escapeHtml(entry.text)}</div>` : ""}
        ${attachmentsHtml}
      </article>
    `;
  };

  app.assistantMessageText = function assistantMessageText(event) {
    const item = event.raw?.params?.item;
    if (event.type === "item/completed" && item?.type === "agentMessage") {
      return String(item.text || event.text || "").trim();
    }
    return "";
  };

  app.activeAssistantDraft = function activeAssistantDraft(job, timeline) {
    const current = String(job.finalMessage || "").trim();
    if (!current) return "";
    if (app.lastTimelineMessageText(timeline, "assistant") === current) return "";
    return current;
  };

  app.lastTimelineMessageText = function lastTimelineMessageText(timeline, role) {
    const item = [...timeline].reverse().find((entry) => entry.kind === "message" && entry.role === role);
    return item?.text || "";
  };

  app.userMessageAttachments = function userMessageAttachments(event) {
    const attachments = Array.isArray(event.raw?.attachments) ? event.raw.attachments : [];
    return attachments.filter((attachment) => attachment?.type === "image" && typeof attachment.url === "string");
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
    return session.updatedAt || session.completedAt || session.startedAt || session.createdAt;
  };

  app.refreshActiveSessionHeader = function refreshActiveSessionHeader() {
    const session = state.composingNewSession ? null : state.selectedCodexSession;
    const runtime = state.runtimeDirty ? app.currentRuntimeDraft() : session?.runtime || state.runtimePreferences;
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
    const runtime = state.runtimeDirty ? app.currentRuntimeDraft() : session?.runtime || state.runtimePreferences;
    const runtimeLabel = app.sessionRuntimeLabel(runtime) || "桌面默认";
    if (session && !app.sessionCanAcceptFollowUp(session)) {
      elements.composerActionsMeta.textContent = `当前会话不可继续，请先从左上角新建会话 · ${runtimeLabel}`;
      return;
    }
    const lead = session ? (app.sessionHasPendingWork(session) ? "继续当前话题，接在这一轮后面" : "继续当前话题") : "发送后创建新话题";
    elements.composerActionsMeta.textContent = `${lead} · ${app.sessionProjectLabel(session?.projectId || elements.codexProject.value)} · ${runtimeLabel}`;
  };
}
