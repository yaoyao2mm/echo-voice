import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { CodexAppServerClient, buildUserInputs } from "./codexAppServerClient.js";
import { formatGitSummary, gitWorkspaceSnapshot, summarizeGitWorkspace } from "./codexGitSummary.js";
import { publicWorkspaces } from "./codexRunner.js";
import { codexCompatibleModel } from "./codexRuntime.js";
import { httpFetch } from "./http.js";

const maxDownloadedAttachmentBytes = 10 * 1024 * 1024;
const streamDeltaFlushDelayMs = 80;
const streamDeltaFlushMaxChars = 1200;

export class CodexInteractiveRuntime {
  constructor(options = {}) {
    this.agentId = options.agentId || "default-agent";
    this.onEvents = options.onEvents || (async () => {});
    this.requestApproval = options.requestApproval || defaultApprovalHandler;
    this.requestInteraction = options.requestInteraction || defaultInteractionHandler;
    this.client = null;
    this.sessions = new Map();
    this.threadToSession = new Map();
    this.activeTurns = new Map();
    this.attachmentDirs = new Map();
    this.eventFlushes = new Map();
    this.deltaBuffers = new Map();
    this.turnGitBaselines = new Map();
    this.collaborationModePresets = null;
    this.collaborationModeUnavailable = false;
    this.expectedClientCloses = new WeakSet();
  }

  async handleCommand(command) {
    try {
      return await this.#handleCommandWithClient(command);
    } catch (error) {
      if (!isCodexAuthRefreshError(error)) throw error;
      this.#restartClientAfterAuthChange();
      return this.#handleCommandWithClient(command);
    }
  }

  stop() {
    this.#cleanupAllAttachmentDirs().catch((error) => {
      console.error(`[codex attachment cleanup] ${error.message}`);
    });
    if (this.client) this.expectedClientCloses.add(this.client);
    this.client?.stop();
    this.client = null;
    this.sessions.clear();
    this.threadToSession.clear();
    this.activeTurns.clear();
    this.turnGitBaselines.clear();
    this.eventFlushes.clear();
    for (const buffer of this.deltaBuffers.values()) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }
    this.deltaBuffers.clear();
  }

  async #startSession(command, workspace) {
    const runtime = this.#runtimeFor(command);
    const threadResult = await this.client.request("thread/start", this.#threadConfig(workspace, runtime), 120000);
    const appThreadId = threadResult?.thread?.id;
    if (!appThreadId) throw new Error("Codex app-server did not return a thread id.");

    this.#rememberSession(command.sessionId, appThreadId, workspace, runtime);
    await this.#emit(command.sessionId, [
      {
        type: "thread.started",
        text: `Interactive Codex thread started in ${workspace.path}.`,
        appThreadId,
        sessionStatus: "active",
        raw: { method: "thread/start", result: threadResult }
      }
    ]);

    const prompt = String(command.payload?.prompt || "").trim();
    const attachments = Array.isArray(command.payload?.attachments) ? command.payload.attachments : [];
    if (!prompt && attachments.length === 0) {
      return { ok: true, appThreadId, sessionStatus: "active" };
    }

    const turn = await this.#startOrSteerTurn({
      sessionId: command.sessionId,
      threadId: appThreadId,
      text: prompt,
      attachments,
      workspace,
      runtime,
      mode: command.payload?.mode
    });
    return { ok: true, appThreadId, activeTurnId: turn.id, sessionStatus: "running" };
  }

  async #handleCommandWithClient(command) {
    await this.#ensureClient();
    const workspace = this.#workspaceFor(command);
    this.#rememberCommand(command);

    if (command.type === "start") return this.#startSession(command, workspace);
    if (command.type === "message") return this.#sendMessage(command, workspace);
    if (command.type === "stop") return this.#stopTurn(command);
    if (command.type === "compact") return this.#compactThread(command, workspace);
    throw new Error(`Unsupported Codex session command: ${command.type}`);
  }

  #restartClientAfterAuthChange() {
    if (this.client) this.expectedClientCloses.add(this.client);
    this.client?.stop();
    this.client = null;
    this.sessions.clear();
    this.threadToSession.clear();
    this.activeTurns.clear();
    this.turnGitBaselines.clear();
  }

  async #sendMessage(command, workspace) {
    const runtime = this.#runtimeFor(command);
    let thread = await this.#ensureThread(command, workspace, runtime);
    const rawText = String(command.payload?.text || "").trim();
    const attachments = Array.isArray(command.payload?.attachments) ? command.payload.attachments : [];
    if (!rawText && attachments.length === 0) throw new Error("Codex session message is empty.");

    try {
      const turn = await this.#startOrSteerTurn({
        sessionId: command.sessionId,
        threadId: thread.appThreadId,
        text: thread.recovered ? recoveredThreadPrompt(command.payload?.history, rawText) : rawText,
        attachments,
        workspace,
        runtime,
        mode: command.payload?.mode
      });
      return { ok: true, appThreadId: thread.appThreadId, activeTurnId: turn.id, sessionStatus: "running" };
    } catch (error) {
      if (!isThreadNotFoundError(error) || thread.recovered) throw error;
      thread = await this.#startReplacementThread(command, workspace, runtime, error);
      const turn = await this.#startOrSteerTurn({
        sessionId: command.sessionId,
        threadId: thread.appThreadId,
        text: recoveredThreadPrompt(command.payload?.history, rawText),
        attachments,
        workspace,
        runtime,
        mode: command.payload?.mode
      });
      return { ok: true, appThreadId: thread.appThreadId, activeTurnId: turn.id, sessionStatus: "running" };
    }
  }

  async #stopTurn(command) {
    const appThreadId = command.appThreadId || this.sessions.get(command.sessionId)?.appThreadId;
    const activeTurnId = command.activeTurnId || (appThreadId ? this.activeTurns.get(appThreadId) : "");
    if (!appThreadId || !activeTurnId) {
      return { ok: true, sessionStatus: "active" };
    }
    await this.client.request("turn/interrupt", { threadId: appThreadId, turnId: activeTurnId }, 30000);
    this.activeTurns.delete(appThreadId);
    await this.#cleanupAttachmentDir(appThreadId);
    await this.#emit(command.sessionId, [
      {
        type: "turn.interrupted",
        text: "Codex turn interrupted from mobile.",
        appThreadId,
        clearActiveTurnId: true,
        sessionStatus: "active",
        raw: { method: "turn/interrupt", threadId: appThreadId, turnId: activeTurnId }
      }
    ]);
    return { ok: true, appThreadId, sessionStatus: "active" };
  }

  async #compactThread(command, workspace) {
    const runtime = this.#runtimeFor(command);
    const thread = await this.#ensureThreadForCompaction(command, workspace, runtime);
    await this.#emit(command.sessionId, [
      {
        type: "context.compaction.started",
        text: "Codex context compaction started.",
        appThreadId: thread.appThreadId,
        sessionStatus: "running",
        raw: { method: "thread/compact/start" }
      }
    ]);
    await this.client.request("thread/compact/start", { threadId: thread.appThreadId }, 60000);
    return { ok: true, appThreadId: thread.appThreadId, sessionStatus: "running" };
  }

  async #startOrSteerTurn({ sessionId, threadId, text, attachments, workspace, runtime, mode }) {
    const preparedAttachments = await this.#materializeAttachments({ sessionId, threadId, attachments, workspace });
    const requestedMode = normalizeSessionMode(mode);
    const inputText = String(text || "").trim();
    const input = buildUserInputs(inputText, preparedAttachments);
    if (input.length === 0) throw new Error("Codex turn input is empty.");
    const activeTurnId = this.activeTurns.get(threadId);
    try {
      if (activeTurnId) {
        const result = await this.client.request(
          "turn/steer",
          {
            threadId,
            input,
            expectedTurnId: activeTurnId
          },
          60000
        );
        await this.#emit(sessionId, [
          {
            type: "turn.steered",
            text: "Message added to the active Codex turn.",
            appThreadId: threadId,
            activeTurnId,
            sessionStatus: "running",
            raw: { method: "turn/steer", result }
          }
        ]);
        return { id: result?.turnId || activeTurnId };
      }

      const turnStartParams = await this.#turnStartParams({
        threadId,
        input,
        cwd: workspace.path,
        runtime,
        mode: requestedMode
      });
      const gitBaseline = await gitWorkspaceSnapshot(workspace.path).catch(() => null);
      let result;
      try {
        result = await this.client.request("turn/start", turnStartParams.params, 60000);
      } catch (error) {
        if (!turnStartParams.nativePlan) throw error;
        this.collaborationModeUnavailable = true;
        const fallbackInput = buildUserInputs(promptForSessionMode(inputText, requestedMode), preparedAttachments);
        result = await this.client.request(
          "turn/start",
          this.#baseTurnStartParams({
            threadId,
            input: fallbackInput,
            cwd: workspace.path,
            runtime
          }),
          60000
        );
        await this.#emit(sessionId, [
          {
            type: "plan.mode.fallback",
            text: `Native Codex plan mode was unavailable; Echo used planning instructions instead. ${error.message || ""}`.trim(),
            appThreadId: threadId,
            raw: { method: "turn/start", mode: "plan", fallback: true, error: error.message || "" }
          }
        ]);
      }
      const turnId = result?.turn?.id;
      if (!turnId) throw new Error("Codex app-server did not return a turn id.");
      this.activeTurns.set(threadId, turnId);
      if (gitBaseline) this.turnGitBaselines.set(turnGitBaselineKey(threadId, turnId), gitBaseline);
      return { id: turnId };
    } catch (error) {
      await this.#cleanupAttachmentDir(threadId);
      throw error;
    }
  }

  async #turnStartParams({ threadId, input, cwd, runtime, mode }) {
    const params = this.#baseTurnStartParams({ threadId, input, cwd, runtime });
    if (mode !== "plan") return { params, nativePlan: false };

    const collaborationMode = await this.#planCollaborationMode(runtime);
    if (!collaborationMode) {
      return {
        params: {
          ...params,
          input: planFallbackInputs(input)
        },
        nativePlan: false
      };
    }

    return {
      params: {
        ...params,
        collaborationMode
      },
      nativePlan: true
    };
  }

  #baseTurnStartParams({ threadId, input, cwd, runtime }) {
    return {
      threadId,
      input,
      cwd,
      approvalPolicy: runtime.approvalPolicy,
      model: runtime.model,
      effort: runtime.reasoningEffort
    };
  }

  async #planCollaborationMode(runtime) {
    const model = String(runtime?.model || "").trim();
    if (!model || this.collaborationModeUnavailable) return null;

    const preset = await this.#planCollaborationPreset();
    if (!preset) return null;
    const effort = normalizeReasoningEffortForCollaboration(
      preset.reasoning_effort ?? preset.reasoningEffort ?? runtime.reasoningEffort ?? "medium"
    );
    return {
      mode: "plan",
      settings: {
        model,
        reasoning_effort: effort || "medium",
        developer_instructions: null
      }
    };
  }

  async #planCollaborationPreset() {
    if (this.collaborationModePresets) return this.collaborationModePresets.plan || null;
    if (this.collaborationModeUnavailable) return null;
    try {
      const result = await this.client.request("collaborationMode/list", {}, 15000);
      const presets = Array.isArray(result?.data) ? result.data : [];
      const plan =
        presets.find((preset) => String(preset?.mode || "").toLowerCase() === "plan") ||
        presets.find((preset) => String(preset?.name || "").toLowerCase() === "plan") ||
        null;
      this.collaborationModePresets = { plan };
      return plan;
    } catch (error) {
      this.collaborationModeUnavailable = true;
      return null;
    }
  }

  async #ensureThread(command, workspace, runtime) {
    if (command.appThreadId) {
      if (!this.threadToSession.has(command.appThreadId)) {
        this.#rememberSession(command.sessionId, command.appThreadId, workspace, runtime);
        let resumeResult;
        try {
          resumeResult = await this.client.request(
            "thread/resume",
            {
              threadId: command.appThreadId,
              ...this.#resumeConfig(workspace, runtime)
            },
            120000
          );
        } catch (error) {
          this.#forgetThread(command.appThreadId);
          if (!isThreadNotFoundError(error)) throw error;
          return this.#startReplacementThread(command, workspace, runtime, error);
        }
        await this.#emit(command.sessionId, [
          {
            type: "thread.resumed",
            text: `Interactive Codex thread resumed in ${workspace.path}.`,
            appThreadId: command.appThreadId,
            sessionStatus: "active",
            raw: { method: "thread/resume", result: resumeResult }
          }
        ]);
      }
      this.#rememberSession(command.sessionId, command.appThreadId, workspace, runtime);
      if (command.activeTurnId) this.activeTurns.set(command.appThreadId, command.activeTurnId);
      return { appThreadId: command.appThreadId, recovered: false };
    }

    const remembered = this.sessions.get(command.sessionId);
    if (remembered?.appThreadId) return { appThreadId: remembered.appThreadId, recovered: false };

    throw new Error("Codex session has no app-server thread id yet.");
  }

  async #ensureThreadForCompaction(command, workspace, runtime) {
    const remembered = this.sessions.get(command.sessionId);
    const appThreadId = command.appThreadId || remembered?.appThreadId || "";
    if (!appThreadId) throw new Error("Codex session has no app-server thread id yet.");
    if (!this.threadToSession.has(appThreadId)) {
      this.#rememberSession(command.sessionId, appThreadId, workspace, runtime);
      try {
        const resumeResult = await this.client.request(
          "thread/resume",
          {
            threadId: appThreadId,
            ...this.#resumeConfig(workspace, runtime)
          },
          120000
        );
        await this.#emit(command.sessionId, [
          {
            type: "thread.resumed",
            text: `Interactive Codex thread resumed in ${workspace.path}.`,
            appThreadId,
            sessionStatus: "active",
            raw: { method: "thread/resume", result: resumeResult }
          }
        ]);
      } catch (error) {
        this.#forgetThread(appThreadId);
        if (!isThreadNotFoundError(error)) throw error;
        throw new Error("Codex thread can no longer be compacted because the local app-server thread was not found.");
      }
    }
    this.#rememberSession(command.sessionId, appThreadId, workspace, runtime);
    return { appThreadId };
  }

  async #startReplacementThread(command, workspace, runtime, reason) {
    if (command.appThreadId) {
      this.activeTurns.delete(command.appThreadId);
      this.threadToSession.delete(command.appThreadId);
    }
    const threadResult = await this.client.request("thread/start", this.#threadConfig(workspace, runtime), 120000);
    const appThreadId = threadResult?.thread?.id;
    if (!appThreadId) throw new Error("Codex app-server did not return a replacement thread id.");

    this.#rememberSession(command.sessionId, appThreadId, workspace, runtime);
    await this.#emit(command.sessionId, [
      {
        type: "thread.restarted",
        text: `Previous Codex thread ${command.appThreadId || "unknown"} could not be resumed; a fresh thread was started.`,
        appThreadId,
        sessionStatus: "active",
        raw: {
          method: "thread/start",
          reason: reason?.message || "",
          previousAppThreadId: command.appThreadId || "",
          result: threadResult
        }
      }
    ]);
    return { appThreadId, recovered: true };
  }

  async #ensureClient() {
    if (this.client?.initialized) return;

    const client = new CodexAppServerClient();
    this.client = client;
    client.on("notification", (message) => this.#handleNotification(message));
    client.on("serverRequest", (message) => this.#handleServerRequest(message));
    client.on("stderr", (line) => this.#handleStderr(line));
    client.on("close", () => {
      const expectedClose = this.expectedClientCloses.has(client);
      this.expectedClientCloses.delete(client);
      if (!expectedClose) {
        this.#emitAppServerClosed().catch((error) => {
          console.error(`[codex app-server close] ${error.message}`);
        });
      }
      this.#cleanupAllAttachmentDirs().catch((error) => {
        console.error(`[codex attachment cleanup] ${error.message}`);
      });
      this.sessions.clear();
      this.threadToSession.clear();
      this.activeTurns.clear();
      this.turnGitBaselines.clear();
      for (const buffer of this.deltaBuffers.values()) {
        if (buffer.timer) clearTimeout(buffer.timer);
      }
      this.deltaBuffers.clear();
    });
    client.on("error", (error) => {
      console.error(`[codex app-server] ${error.message}`);
    });
    await client.start();
  }

  async #emitAppServerClosed() {
    const eventsBySession = new Map();
    for (const [threadId, activeTurnId] of this.activeTurns.entries()) {
      const sessionId = this.threadToSession.get(threadId);
      if (!sessionId) continue;
      const events = eventsBySession.get(sessionId) || [];
      events.push({
        type: "runtime.closed",
        text: "Codex app-server exited while a turn was running.",
        appThreadId: threadId,
        activeTurnId,
        clearActiveTurnId: true,
        sessionStatus: "active",
        error: "Codex app-server exited while a turn was running.",
        raw: { method: "codex/app-server/closed", threadId, turnId: activeTurnId }
      });
      eventsBySession.set(sessionId, events);
    }
    for (const [sessionId, events] of eventsBySession) {
      await this.#emitAfterPendingDeltas(sessionId, events);
    }
  }

  #threadConfig(workspace, runtime) {
    return {
      cwd: workspace.path,
      approvalPolicy: runtime.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: normalizeSandboxMode(runtime.sandbox),
      serviceName: "echo-codex",
      model: runtime.model,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    };
  }

  #resumeConfig(workspace, runtime) {
    return {
      cwd: workspace.path,
      approvalPolicy: runtime.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: normalizeSandboxMode(runtime.sandbox),
      model: runtime.model,
      persistExtendedHistory: false
    };
  }

  #workspaceFor(commandOrProjectId) {
    const projectId =
      typeof commandOrProjectId === "object" ? String(commandOrProjectId.projectId || "").trim() : String(commandOrProjectId || "").trim();
    const workspace = publicWorkspaces().find((item) => item.id === projectId);
    if (!workspace) {
      throw new Error(`Project is not allowed on this desktop agent: ${projectId}`);
    }
    const execution = typeof commandOrProjectId === "object" && commandOrProjectId.execution ? commandOrProjectId.execution : null;
    const executionPath = String(execution?.path || "").trim();
    if (!executionPath) return workspace;
    const resolvedExecutionPath = path.resolve(executionPath);
    const resolvedWorktreeRoot = path.resolve(config.codex.worktreeRoot || path.join(config.dataDir, "worktrees"));
    if (!isPathInside(resolvedExecutionPath, resolvedWorktreeRoot)) {
      throw new Error("Codex execution path is outside the desktop-controlled worktree root.");
    }
    return {
      ...workspace,
      path: resolvedExecutionPath,
      basePath: workspace.path,
      execution
    };
  }

  #rememberCommand(command) {
    if (!command.appThreadId || !this.threadToSession.has(command.appThreadId)) return;
    this.#rememberSession(command.sessionId, command.appThreadId, this.#workspaceFor(command), this.#runtimeFor(command));
    if (command.activeTurnId) this.activeTurns.set(command.appThreadId, command.activeTurnId);
  }

  #rememberSession(sessionId, appThreadId, workspace, runtime) {
    this.sessions.set(sessionId, { appThreadId, projectId: workspace.id, workspace, runtime });
    this.threadToSession.set(appThreadId, sessionId);
  }

  #forgetThread(appThreadId) {
    const sessionId = this.threadToSession.get(appThreadId);
    this.threadToSession.delete(appThreadId);
    this.activeTurns.delete(appThreadId);
    if (sessionId && this.sessions.get(sessionId)?.appThreadId === appThreadId) {
      this.sessions.delete(sessionId);
    }
  }

  #runtimeFor(command = {}) {
    const remembered = this.sessions.get(command.sessionId)?.runtime || {};
    const runtime = command.runtime && typeof command.runtime === "object" ? command.runtime : remembered;
    return {
      approvalPolicy: String(runtime.approvalPolicy || config.codex.approvalPolicy || "on-request").trim() || "on-request",
      sandbox: String(runtime.sandbox || config.codex.sandbox || "workspace-write").trim() || "workspace-write",
      model: codexCompatibleModel(runtime.model || config.codex.model) || null,
      reasoningEffort:
        String(runtime.reasoningEffort || runtime.effort || config.codex.reasoningEffort || "").trim().toLowerCase() || null
    };
  }

  #handleNotification(message) {
    const threadId = getThreadId(message);
    const sessionId = threadId ? this.threadToSession.get(threadId) : "";
    if (!sessionId) return;

    const event = notificationToEvent(message);
    if (!event) return;
    if (message.method === "turn/started") {
      this.activeTurns.set(threadId, message.params?.turn?.id || "");
    }
    if (message.method === "turn/completed") {
      this.activeTurns.delete(threadId);
      this.#cleanupAttachmentDir(threadId).catch((error) => {
        console.error(`[codex attachment cleanup] ${error.message}`);
      });
      this.#emitTurnCompleted(sessionId, threadId, event).catch((error) => {
        console.error(`[codex app-server event] ${error.message}`);
      });
      return;
    }
    if (bufferedDeltaKey(event)) {
      this.#bufferDeltaEvent(sessionId, event);
      return;
    }
    this.#emitAfterPendingDeltas(sessionId, [event]).catch((error) => {
      console.error(`[codex app-server event] ${error.message}`);
    });
  }

  #handleServerRequest(message) {
    this.#handleServerRequestAsync(message).catch((error) => {
      this.client.reject(message.id, -32603, error.message || "Echo Codex approval handling failed.");
    });
  }

  async #handleServerRequestAsync(message) {
    const threadId = getThreadId(message);
    const sessionId = threadId ? this.threadToSession.get(threadId) : "";
    const fallback = declineApprovalResponse(message.method);
    const userInputFallback = userInputResponseFallback(message.method);
    if (!sessionId || (!fallback && !userInputFallback)) {
      if (fallback) this.client.respond(message.id, fallback);
      else if (userInputFallback) this.client.respond(message.id, userInputFallback);
      else this.client.reject(message.id, -32603, "Echo Codex does not support this interactive request yet.");
      return;
    }

    if (userInputFallback) {
      const interaction = {
        sessionId,
        appRequestId: String(message.id),
        method: message.method,
        kind: "user_input",
        prompt: userInputRequestText(message),
        payload: message.params || {}
      };
      const response = await this.requestInteraction(interaction);
      if (response) {
        this.client.respond(message.id, response);
      } else {
        this.client.respond(message.id, userInputFallback);
      }
      return;
    }

    const approval = {
      sessionId,
      appRequestId: String(message.id),
      method: message.method,
      prompt: approvalRequestText(message),
      payload: message.params || {}
    };
    const response = await this.requestApproval(approval);
    if (response) {
      this.client.respond(message.id, response);
    } else {
      this.client.respond(message.id, fallback);
    }
  }

  #handleStderr(line) {
    if (!/ERROR|WARN/i.test(line)) return;
    console.warn(`[codex app-server] ${line}`);
  }

  async #emit(sessionId, events) {
    return this.#enqueueEventTask(sessionId, () => this.onEvents(sessionId, events));
  }

  #enqueueEventTask(sessionId, task) {
    const previous = this.eventFlushes.get(sessionId) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.eventFlushes.set(sessionId, current);
    const cleanup = () => {
      if (this.eventFlushes.get(sessionId) === current) {
        this.eventFlushes.delete(sessionId);
      }
    };
    current.then(cleanup, cleanup);
    return current;
  }

  async #emitAfterPendingDeltas(sessionId, events) {
    const pendingDelta = this.#takePendingDelta(sessionId);
    return this.#enqueueEventTask(sessionId, async () => {
      if (pendingDelta) await this.onEvents(sessionId, [pendingDelta]);
      await this.onEvents(sessionId, events);
    });
  }

  #bufferDeltaEvent(sessionId, event) {
    const key = bufferedDeltaKey(event);
    if (!key) {
      this.#emitAfterPendingDeltas(sessionId, [event]).catch((error) => {
        console.error(`[codex app-server event] ${error.message}`);
      });
      return;
    }

    const existing = this.deltaBuffers.get(sessionId);
    if (existing && existing.key !== key) {
      this.#flushPendingDelta(sessionId)?.catch((error) => {
        console.error(`[codex app-server event] ${error.message}`);
      });
    }

    const buffer = this.deltaBuffers.get(sessionId);
    if (buffer && buffer.key === key) {
      appendDeltaEvent(buffer.event, event);
      if (String(buffer.event.text || "").length >= streamDeltaFlushMaxChars) {
        this.#flushPendingDelta(sessionId)?.catch((error) => {
          console.error(`[codex app-server event] ${error.message}`);
        });
      }
      return;
    }

    const nextBuffer = {
      key,
      event: cloneDeltaEvent(event),
      timer: setTimeout(() => {
        this.#flushPendingDelta(sessionId)?.catch((error) => {
          console.error(`[codex app-server event] ${error.message}`);
        });
      }, streamDeltaFlushDelayMs)
    };
    this.deltaBuffers.set(sessionId, nextBuffer);
  }

  #flushPendingDelta(sessionId) {
    const pendingDelta = this.#takePendingDelta(sessionId);
    if (!pendingDelta) return null;
    return this.#enqueueEventTask(sessionId, () => this.onEvents(sessionId, [pendingDelta]));
  }

  #takePendingDelta(sessionId) {
    const buffer = this.deltaBuffers.get(sessionId);
    if (!buffer) return null;
    this.deltaBuffers.delete(sessionId);
    if (buffer.timer) clearTimeout(buffer.timer);
    return buffer.event;
  }

  async #emitTurnCompleted(sessionId, threadId, event) {
    const pendingDelta = this.#takePendingDelta(sessionId);
    return this.#enqueueEventTask(sessionId, async () => {
      if (pendingDelta) await this.onEvents(sessionId, [pendingDelta]);
      const events = [event];
      try {
      const gitSummary = await this.#gitSummaryEvent(sessionId, threadId, event);
        if (gitSummary) events.push(gitSummary);
      } catch (error) {
        console.error(`[codex git summary] ${error.message}`);
      }
      await this.onEvents(sessionId, events);
    });
  }

  async #gitSummaryEvent(sessionId, threadId, event) {
    const workspacePath = this.sessions.get(sessionId)?.workspace?.path;
    const turnId = event?.raw?.params?.turn?.id || event?.raw?.params?.turnId || event?.activeTurnId || "";
    const baselineKey = turnGitBaselineKey(threadId, turnId);
    const baseline = this.turnGitBaselines.get(baselineKey) || null;
    if (baselineKey) this.turnGitBaselines.delete(baselineKey);
    const summary = await summarizeGitWorkspace(workspacePath, { baseline });
    if (!summary) return null;
    return {
      type: "git.summary",
      text: formatGitSummary(summary),
      appThreadId: threadId,
      raw: {
        source: "desktop-agent",
        gitSummary: summary
      }
    };
  }

  async #materializeAttachments({ sessionId, threadId, attachments, workspace }) {
    const materialized = Array.isArray(attachments)
      ? attachments
          .filter((attachment) => attachment?.type === "localImage" && String(attachment.path || "").trim())
          .map((attachment) => ({
            ...attachment,
            path: String(attachment.path || "").trim()
          }))
      : [];
    const images = Array.isArray(attachments) ? attachments.filter((attachment) => attachment?.type === "image") : [];
    if (images.length === 0) return materialized;

    const attachmentDir = await this.#ensureAttachmentDir(workspace.path, sessionId, threadId);
    for (const [index, attachment] of images.entries()) {
      const image = await loadImageAttachment(attachment);
      if (!image) continue;
      const filePath = path.join(attachmentDir, buildAttachmentFileName(attachment, index, image.extension));
      await fs.writeFile(filePath, image.buffer, { mode: 0o600 });
      materialized.push({ type: "localImage", path: filePath });
    }
    return materialized;
  }

  async #ensureAttachmentDir(workspacePath, sessionId, threadId) {
    const dirPath =
      this.attachmentDirs.get(threadId) ||
      path.join(workspacePath, ".echo-codex-attachments", sanitizePathSegment(sessionId), sanitizePathSegment(threadId));
    await fs.mkdir(dirPath, { recursive: true });
    this.attachmentDirs.set(threadId, dirPath);
    return dirPath;
  }

  async #cleanupAttachmentDir(threadId) {
    const dirPath = this.attachmentDirs.get(threadId);
    if (!dirPath) return;
    this.attachmentDirs.delete(threadId);
    await fs.rm(dirPath, { recursive: true, force: true });
  }

  async #cleanupAllAttachmentDirs() {
    const threadIds = Array.from(this.attachmentDirs.keys());
    await Promise.all(threadIds.map((threadId) => this.#cleanupAttachmentDir(threadId)));
  }
}

function buildAttachmentFileName(attachment, index, extension) {
  const originalName = String(attachment?.name || "").trim();
  const parsed = originalName ? path.parse(originalName).name : `image-${index + 1}`;
  const baseName = sanitizePathSegment(parsed || `image-${index + 1}`);
  return `${baseName}-${randomUUID()}.${extension}`;
}

function sanitizePathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "attachment";
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseImageDataUrl(url) {
  const match = /^data:(image\/[a-z0-9.+_-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(url || "").trim());
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, "");
  if (!base64) return null;
  return {
    mimeType,
    extension: extensionFromMimeType(mimeType),
    buffer: Buffer.from(base64, "base64")
  };
}

async function loadImageAttachment(attachment) {
  const dataUrl = String(attachment?.url || "").trim();
  if (dataUrl.startsWith("data:image/")) return parseImageDataUrl(dataUrl);
  return downloadRelayImageAttachment(attachment);
}

async function downloadRelayImageAttachment(attachment) {
  const url = relayAttachmentUrl(attachment);
  if (!url) return null;

  const response = await httpFetch(url, {
    headers: {
      "X-Echo-Token": config.token
    },
    timeoutMs: config.network.timeoutMs
  });
  if (!response.ok) {
    throw new Error(`Could not download Codex attachment ${attachmentLabel(attachment)}: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxDownloadedAttachmentBytes) {
    throw new Error(`Codex attachment ${attachmentLabel(attachment)} is too large to download.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxDownloadedAttachmentBytes) {
    throw new Error(`Codex attachment ${attachmentLabel(attachment)} is too large to download.`);
  }

  const expectedSha = String(attachment?.sha256 || "").trim().toLowerCase();
  if (expectedSha) {
    const actualSha = createHash("sha256").update(buffer).digest("hex");
    if (actualSha !== expectedSha) {
      throw new Error(`Downloaded Codex attachment ${attachmentLabel(attachment)} did not match its checksum.`);
    }
  }

  const mimeType = imageMimeType(response.headers.get("content-type") || attachment?.mimeType || "");
  return {
    mimeType,
    extension: extensionFromMimeType(mimeType),
    buffer
  };
}

function relayAttachmentUrl(attachment) {
  const explicitPath = String(attachment?.downloadPath || "").trim();
  const attachmentId = String(attachment?.attachmentId || attachment?.id || "").trim();
  const pathOrUrl = explicitPath || (attachmentId ? `/api/agent/codex/attachments/${encodeURIComponent(attachmentId)}` : "");
  if (!pathOrUrl) return "";
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (!config.relayUrl) throw new Error("Cannot download Codex attachment because ECHO_RELAY_URL is not configured.");
  return new URL(pathOrUrl, `${config.relayUrl}/`).toString();
}

function imageMimeType(value) {
  const mimeType = String(value || "").split(";")[0].trim().toLowerCase();
  if (!mimeType) return "image/png";
  if (!mimeType.startsWith("image/")) throw new Error(`Codex attachment is not an image: ${mimeType}`);
  return mimeType;
}

function attachmentLabel(attachment) {
  return String(attachment?.name || attachment?.attachmentId || attachment?.id || "image").trim() || "image";
}

function extensionFromMimeType(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  return mimeType.split("/")[1]?.replace(/[^a-z0-9.+_-]+/gi, "") || "png";
}

function isThreadNotFoundError(error) {
  return /thread not found|not found.*thread/i.test(String(error?.message || ""));
}

function recoveredThreadPrompt(history = [], currentText = "") {
  const current = String(currentText || "").trim();
  const visibleHistory = Array.isArray(history)
    ? history
        .map((message) => ({
          role: message?.role === "assistant" ? "Codex" : "User",
          text: String(message?.text || "").trim()
        }))
        .filter((message) => message.text)
        .slice(-12)
    : [];
  if (visibleHistory.length === 0) return current;

  const lines = [
    "这是一个从移动端恢复的 Codex 会话。之前的本地 Codex thread 已失效，下面是这次会话中可见的最近上下文，请在此基础上继续。",
    "",
    "最近上下文："
  ];
  for (const message of visibleHistory) {
    lines.push(`${message.role}: ${message.text}`);
  }
  lines.push("", "当前用户消息：", current || "（本条消息只有附件或截图，请结合附件继续。）");
  return lines.join("\n");
}

function normalizeSandboxMode(value) {
  const text = String(value || "workspace-write").trim();
  if (text === "workspaceWrite") return "workspace-write";
  if (text === "dangerFullAccess") return "danger-full-access";
  if (text === "readOnly") return "read-only";
  return text;
}

function getThreadId(message) {
  return message.params?.threadId || message.params?.thread?.id || message.params?.item?.threadId || "";
}

function bufferedDeltaKey(event) {
  const method = event?.raw?.method || event?.type || "";
  if (!isBufferedDeltaMethod(method)) return "";
  const params = event.raw?.params || {};
  const threadId = params.threadId || params.thread?.id || params.item?.threadId || event.appThreadId || "";
  const turnId = params.turnId || params.turn?.id || event.activeTurnId || "";
  const itemId = params.itemId || params.item?.id || "";
  return [method, threadId, turnId, itemId].join("\u001f");
}

function turnGitBaselineKey(threadId, turnId) {
  const thread = String(threadId || "").trim();
  const turn = String(turnId || "").trim();
  return thread && turn ? `${thread}\u001f${turn}` : "";
}

function isBufferedDeltaMethod(method) {
  return (
    method === "item/agentMessage/delta" ||
    method === "item/plan/delta" ||
    method === "command/exec/outputDelta" ||
    method === "item/commandExecution/outputDelta"
  );
}

function cloneDeltaEvent(event) {
  return {
    ...event,
    raw: event.raw
      ? {
          ...event.raw,
          params: event.raw.params ? { ...event.raw.params } : event.raw.params
        }
      : event.raw
  };
}

function appendDeltaEvent(target, event) {
  const delta = String(event.text || event.raw?.params?.delta || "");
  const finalDelta = String(event.finalMessage || "");
  target.text = `${target.text || ""}${delta}`;
  if (finalDelta) target.finalMessage = `${target.finalMessage || ""}${finalDelta}`;
  if (target.raw?.params) {
    target.raw.params.delta = `${target.raw.params.delta || ""}${delta}`;
  }
}

function notificationToEvent(message) {
  const type = message.method || "codex";
  const event = {
    type,
    text: notificationText(message),
    raw: message
  };

  const threadId = getThreadId(message);
  if (threadId) event.appThreadId = threadId;
  if (message.method === "turn/started") {
    event.activeTurnId = message.params?.turn?.id || "";
    event.sessionStatus = "running";
  }
  if (message.method === "turn/completed") {
    event.clearActiveTurnId = true;
    const failed = message.params?.turn?.status === "failed";
    event.sessionStatus = failed ? "failed" : "active";
    event.error = message.params?.turn?.error?.message || "";
  }
  if (message.method === "item/agentMessage/delta") {
    event.finalMessage = message.params?.delta || "";
  }
  if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
    event.finalMessage = message.params.item.text || "";
  }
  return event;
}

function notificationText(message) {
  const params = message.params || {};
  if (message.method === "item/agentMessage/delta") return params.delta || "";
  if (message.method === "item/plan/delta") return params.delta || "";
  if (message.method === "command/exec/outputDelta") return params.delta || "";
  if (message.method === "item/commandExecution/outputDelta") return params.delta || "";
  if (message.method === "turn/plan/updated") {
    return (params.plan || []).map((item) => `${item.status || "pending"}: ${item.step || ""}`).join("\n");
  }
  if (message.method === "turn/diff/updated") return params.diff || "";
  if (message.method === "turn/completed") {
    const status = params.turn?.status || "completed";
    const error = params.turn?.error?.message;
    return error ? `Turn ${status}: ${error}` : `Turn ${status}.`;
  }
  if (message.method === "thread/compacted") return "Context compaction completed.";
  if (message.method === "thread/tokenUsage/updated") return tokenUsageText(params.tokenUsage);
  if (message.method === "turn/started") return "Codex turn started.";
  if (message.method === "thread/status/changed") return `Thread status changed: ${JSON.stringify(params.status || {})}`;
  if (message.method === "item/started") return itemLabel(params.item, "started");
  if (message.method === "item/completed") return itemLabel(params.item, "completed");
  return `[${message.method}]`;
}

function tokenUsageText(tokenUsage = {}) {
  const lastTotal = Number(tokenUsage?.last?.totalTokens);
  const contextWindow = Number(tokenUsage?.modelContextWindow);
  if (Number.isFinite(lastTotal) && Number.isFinite(contextWindow) && contextWindow > 0) {
    return `Context usage updated: ${Math.max(0, Math.round(lastTotal))} / ${Math.round(contextWindow)} tokens.`;
  }
  if (Number.isFinite(lastTotal)) return `Context usage updated: ${Math.max(0, Math.round(lastTotal))} tokens.`;
  return "Context usage updated.";
}

function itemLabel(item = {}, fallbackStatus = "") {
  if (item.type === "agentMessage") return item.text || "";
  if (item.type === "plan") return item.text || "";
  if (item.type === "contextCompaction") return "Context compaction completed.";
  if (item.type === "commandExecution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : item.command || "command";
    const output = item.aggregatedOutput ? `\n${item.aggregatedOutput}` : "";
    return `${command} ${item.status || fallbackStatus}${output}`;
  }
  if (item.type === "fileChange") {
    const paths = (item.changes || []).map((change) => change.path).filter(Boolean).join(", ");
    return `File change ${item.status || fallbackStatus}${paths ? `: ${paths}` : ""}`;
  }
  if (item.type === "reasoning") return (item.summary || []).map((part) => part.text || "").filter(Boolean).join("\n");
  return `[${item.type || "item"}.${fallbackStatus}]`;
}

function approvalRequestText(message) {
  if (message.method === "item/commandExecution/requestApproval") {
    const command = Array.isArray(message.params?.command) ? message.params.command.join(" ") : message.params?.command || "command";
    return `Codex requested command approval: ${command}`;
  }
  if (message.method === "item/fileChange/requestApproval") {
    const target = message.params?.grantRoot ? ` for ${message.params.grantRoot}` : "";
    return `Codex requested file-change approval${target}.`;
  }
  return `Codex requested ${message.method}.`;
}

function userInputRequestText(message) {
  const questions = Array.isArray(message.params?.questions) ? message.params.questions : [];
  const first = questions[0] || {};
  const header = String(first.header || "").trim();
  const question = String(first.question || "").trim();
  if (header && question) return `${header}: ${question}`;
  if (question) return question;
  if (header) return header;
  return "Codex requested input.";
}

function declineApprovalResponse(method) {
  if (method === "item/commandExecution/requestApproval") return { decision: "decline" };
  if (method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (method === "execCommandApproval") return { decision: "denied" };
  if (method === "applyPatchApproval") return { decision: "denied" };
  return null;
}

function userInputResponseFallback(method) {
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") return { answers: {} };
  return null;
}

function normalizeSessionMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "plan" ? "plan" : "execute";
}

function promptForSessionMode(text, mode) {
  const normalized = String(text || "").trim();
  if (mode !== "plan" || !normalized) return normalized;
  return [
    "请先进入计划模式，只分析并给出可执行计划。",
    "不要修改文件，不要提交、推送、部署，也不要运行会改变仓库状态的命令。",
    "如果需要验证，请只说明建议运行哪些检查，等待我确认后再执行。",
    "",
    "用户请求：",
    normalized
  ].join("\n");
}

function inputTextFromInputs(input = []) {
  return (Array.isArray(input) ? input : [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text || "")
    .filter(Boolean)
    .join("\n");
}

function planFallbackInputs(input = []) {
  const attachments = (Array.isArray(input) ? input : []).filter((item) => item?.type !== "text");
  const text = promptForSessionMode(inputTextFromInputs(input), "plan");
  return text ? [{ type: "text", text, text_elements: [] }, ...attachments] : attachments;
}

function normalizeReasoningEffortForCollaboration(value) {
  const effort = typeof value === "string" ? value : value === null ? "" : String(value || "");
  const normalized = effort.trim().toLowerCase();
  return ["low", "medium", "high", "xhigh"].includes(normalized) ? normalized : "";
}

function isCodexAuthRefreshError(error) {
  const message = String(error?.message || error || "");
  return /access token could not be refreshed|logged out or signed in to another account|sign in again/i.test(message);
}

async function defaultApprovalHandler(approval) {
  return declineApprovalResponse(approval.method);
}

async function defaultInteractionHandler(interaction) {
  return userInputResponseFallback(interaction.method) || {};
}
