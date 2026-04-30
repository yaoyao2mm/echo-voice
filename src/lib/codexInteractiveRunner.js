import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { CodexAppServerClient, buildUserInputs } from "./codexAppServerClient.js";
import { codexCompatibleModel } from "./codexRuntime.js";

export class CodexInteractiveRuntime {
  constructor(options = {}) {
    this.agentId = options.agentId || "default-agent";
    this.onEvents = options.onEvents || (async () => {});
    this.requestApproval = options.requestApproval || defaultApprovalHandler;
    this.client = null;
    this.sessions = new Map();
    this.threadToSession = new Map();
    this.activeTurns = new Map();
    this.attachmentDirs = new Map();
  }

  async handleCommand(command) {
    await this.#ensureClient();
    const workspace = this.#workspaceFor(command.projectId);
    this.#rememberCommand(command);

    if (command.type === "start") return this.#startSession(command, workspace);
    if (command.type === "message") return this.#sendMessage(command, workspace);
    if (command.type === "stop") return this.#stopTurn(command);
    throw new Error(`Unsupported Codex session command: ${command.type}`);
  }

  stop() {
    this.#cleanupAllAttachmentDirs().catch((error) => {
      console.error(`[codex attachment cleanup] ${error.message}`);
    });
    this.client?.stop();
    this.client = null;
    this.sessions.clear();
    this.threadToSession.clear();
    this.activeTurns.clear();
  }

  async #startSession(command, workspace) {
    const runtime = this.#runtimeFor(command);
    const threadResult = await this.client.request("thread/start", this.#threadConfig(workspace, runtime), 120000);
    const appThreadId = threadResult?.thread?.id;
    if (!appThreadId) throw new Error("Codex app-server did not return a thread id.");

    this.#rememberSession(command.sessionId, appThreadId, workspace.id, runtime);
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
      runtime
    });
    return { ok: true, appThreadId, activeTurnId: turn.id, sessionStatus: "running" };
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
        runtime
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
        runtime
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
    return { ok: true, appThreadId, sessionStatus: "active" };
  }

  async #startOrSteerTurn({ sessionId, threadId, text, attachments, workspace, runtime }) {
    const preparedAttachments = await this.#materializeAttachments({ sessionId, threadId, attachments, workspace });
    const input = buildUserInputs(text, preparedAttachments);
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

      const result = await this.client.request(
        "turn/start",
        {
          threadId,
          input,
          cwd: workspace.path,
          approvalPolicy: runtime.approvalPolicy,
          model: runtime.model,
          effort: runtime.reasoningEffort
        },
        60000
      );
      const turnId = result?.turn?.id;
      if (!turnId) throw new Error("Codex app-server did not return a turn id.");
      this.activeTurns.set(threadId, turnId);
      return { id: turnId };
    } catch (error) {
      await this.#cleanupAttachmentDir(threadId);
      throw error;
    }
  }

  async #ensureThread(command, workspace, runtime) {
    if (command.appThreadId) {
      if (!this.threadToSession.has(command.appThreadId)) {
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
      this.#rememberSession(command.sessionId, command.appThreadId, workspace.id, runtime);
      if (command.activeTurnId) this.activeTurns.set(command.appThreadId, command.activeTurnId);
      return { appThreadId: command.appThreadId, recovered: false };
    }

    const remembered = this.sessions.get(command.sessionId);
    if (remembered?.appThreadId) return { appThreadId: remembered.appThreadId, recovered: false };

    throw new Error("Codex session has no app-server thread id yet.");
  }

  async #startReplacementThread(command, workspace, runtime, reason) {
    if (command.appThreadId) {
      this.activeTurns.delete(command.appThreadId);
      this.threadToSession.delete(command.appThreadId);
    }
    const threadResult = await this.client.request("thread/start", this.#threadConfig(workspace, runtime), 120000);
    const appThreadId = threadResult?.thread?.id;
    if (!appThreadId) throw new Error("Codex app-server did not return a replacement thread id.");

    this.#rememberSession(command.sessionId, appThreadId, workspace.id, runtime);
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

    this.client = new CodexAppServerClient({
      command: config.codex.command
    });
    this.client.on("notification", (message) => this.#handleNotification(message));
    this.client.on("serverRequest", (message) => this.#handleServerRequest(message));
    this.client.on("stderr", (line) => this.#handleStderr(line));
    this.client.on("close", () => {
      this.#cleanupAllAttachmentDirs().catch((error) => {
        console.error(`[codex attachment cleanup] ${error.message}`);
      });
      this.sessions.clear();
      this.threadToSession.clear();
      this.activeTurns.clear();
    });
    this.client.on("error", (error) => {
      console.error(`[codex app-server] ${error.message}`);
    });
    await this.client.start();
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

  #workspaceFor(projectId) {
    const workspace = config.codex.workspaces.find((item) => item.id === projectId);
    if (!workspace) {
      throw new Error(`Project is not allowed on this desktop agent: ${projectId}`);
    }
    return workspace;
  }

  #rememberCommand(command) {
    if (!command.appThreadId || !this.threadToSession.has(command.appThreadId)) return;
    this.#rememberSession(command.sessionId, command.appThreadId, command.projectId, this.#runtimeFor(command));
    if (command.activeTurnId) this.activeTurns.set(command.appThreadId, command.activeTurnId);
  }

  #rememberSession(sessionId, appThreadId, projectId, runtime) {
    this.sessions.set(sessionId, { appThreadId, projectId, runtime });
    this.threadToSession.set(appThreadId, sessionId);
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
    }
    this.#emit(sessionId, [event]).catch((error) => {
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
    if (!sessionId || !fallback) {
      if (fallback) this.client.respond(message.id, fallback);
      else this.client.reject(message.id, -32603, "Echo Codex does not support this interactive request yet.");
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
    await this.onEvents(sessionId, events);
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
      const image = parseImageDataUrl(String(attachment.url || ""));
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
  if (message.method === "turn/started") return "Codex turn started.";
  if (message.method === "thread/status/changed") return `Thread status changed: ${JSON.stringify(params.status || {})}`;
  if (message.method === "item/started") return itemLabel(params.item, "started");
  if (message.method === "item/completed") return itemLabel(params.item, "completed");
  return `[${message.method}]`;
}

function itemLabel(item = {}, fallbackStatus = "") {
  if (item.type === "agentMessage") return item.text || "";
  if (item.type === "plan") return item.text || "";
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

function declineApprovalResponse(method) {
  if (method === "item/commandExecution/requestApproval") return { decision: "decline" };
  if (method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (method === "execCommandApproval") return { decision: "denied" };
  if (method === "applyPatchApproval") return { decision: "denied" };
  return null;
}

async function defaultApprovalHandler(approval) {
  return declineApprovalResponse(approval.method);
}
