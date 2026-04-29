import { config } from "../config.js";
import { CodexAppServerClient, buildUserTextInput } from "./codexAppServerClient.js";

export class CodexInteractiveRuntime {
  constructor(options = {}) {
    this.agentId = options.agentId || "default-agent";
    this.onEvents = options.onEvents || (async () => {});
    this.requestApproval = options.requestApproval || defaultApprovalHandler;
    this.client = null;
    this.sessions = new Map();
    this.threadToSession = new Map();
    this.activeTurns = new Map();
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
    this.client?.stop();
    this.client = null;
    this.sessions.clear();
    this.threadToSession.clear();
    this.activeTurns.clear();
  }

  async #startSession(command, workspace) {
    const threadResult = await this.client.request("thread/start", this.#threadConfig(workspace), 120000);
    const appThreadId = threadResult?.thread?.id;
    if (!appThreadId) throw new Error("Codex app-server did not return a thread id.");

    this.#rememberSession(command.sessionId, appThreadId, workspace.id);
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
    if (!prompt) {
      return { ok: true, appThreadId, sessionStatus: "active" };
    }

    const turn = await this.#startOrSteerTurn({
      sessionId: command.sessionId,
      threadId: appThreadId,
      text: prompt,
      workspace
    });
    return { ok: true, appThreadId, activeTurnId: turn.id, sessionStatus: "running" };
  }

  async #sendMessage(command, workspace) {
    const appThreadId = await this.#ensureThread(command, workspace);
    const text = String(command.payload?.text || "").trim();
    if (!text) throw new Error("Codex session message is empty.");

    const turn = await this.#startOrSteerTurn({
      sessionId: command.sessionId,
      threadId: appThreadId,
      text,
      workspace
    });
    return { ok: true, appThreadId, activeTurnId: turn.id, sessionStatus: "running" };
  }

  async #stopTurn(command) {
    const appThreadId = command.appThreadId || this.sessions.get(command.sessionId)?.appThreadId;
    const activeTurnId = command.activeTurnId || (appThreadId ? this.activeTurns.get(appThreadId) : "");
    if (!appThreadId || !activeTurnId) {
      return { ok: true, sessionStatus: "active" };
    }
    await this.client.request("turn/interrupt", { threadId: appThreadId, turnId: activeTurnId }, 30000);
    this.activeTurns.delete(appThreadId);
    return { ok: true, appThreadId, sessionStatus: "active" };
  }

  async #startOrSteerTurn({ sessionId, threadId, text, workspace }) {
    const input = [buildUserTextInput(text)];
    const activeTurnId = this.activeTurns.get(threadId);
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
        approvalPolicy: config.codex.approvalPolicy,
        model: config.codex.model || null
      },
      60000
    );
    const turnId = result?.turn?.id;
    if (!turnId) throw new Error("Codex app-server did not return a turn id.");
    this.activeTurns.set(threadId, turnId);
    return { id: turnId };
  }

  async #ensureThread(command, workspace) {
    if (command.appThreadId) {
      if (!this.threadToSession.has(command.appThreadId)) {
        const resumeResult = await this.client.request(
          "thread/resume",
          {
            threadId: command.appThreadId,
            ...this.#resumeConfig(workspace)
          },
          120000
        );
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
      this.#rememberSession(command.sessionId, command.appThreadId, workspace.id);
      return command.appThreadId;
    }

    const remembered = this.sessions.get(command.sessionId);
    if (remembered?.appThreadId) return remembered.appThreadId;

    throw new Error("Codex session has no app-server thread id yet.");
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
      this.sessions.clear();
      this.threadToSession.clear();
      this.activeTurns.clear();
    });
    this.client.on("error", (error) => {
      console.error(`[codex app-server] ${error.message}`);
    });
    await this.client.start();
  }

  #threadConfig(workspace) {
    return {
      cwd: workspace.path,
      approvalPolicy: config.codex.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: normalizeSandboxMode(config.codex.sandbox),
      serviceName: "echo-codex",
      model: config.codex.model || null,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    };
  }

  #resumeConfig(workspace) {
    return {
      cwd: workspace.path,
      approvalPolicy: config.codex.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: normalizeSandboxMode(config.codex.sandbox),
      model: config.codex.model || null,
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
    if (command.appThreadId) this.#rememberSession(command.sessionId, command.appThreadId, command.projectId);
    if (command.appThreadId && command.activeTurnId) this.activeTurns.set(command.appThreadId, command.activeTurnId);
  }

  #rememberSession(sessionId, appThreadId, projectId) {
    this.sessions.set(sessionId, { appThreadId, projectId });
    this.threadToSession.set(appThreadId, sessionId);
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
