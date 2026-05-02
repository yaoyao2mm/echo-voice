import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { config } from "../config.js";
import { resolveDesktopCodexCommand } from "./codexCommand.js";
import { buildCodexEnv } from "./codexRunner.js";

const defaultRequestTimeoutMs = 60000;

export class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    const commandInfo = options.command
      ? { ok: true, command: options.command, source: "explicit-command", detail: `Using explicit command ${options.command}.` }
      : resolveDesktopCodexCommand({
          configuredCommand: config.codex.command,
          bundledPath: config.codex.appPath
        });
    this.command = commandInfo.command;
    this.commandInfo = commandInfo;
    this.cwd = options.cwd || process.cwd();
    this.requestTimeoutMs = options.requestTimeoutMs || defaultRequestTimeoutMs;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.initialized = false;
    this.startPromise = null;
  }

  async start() {
    if (this.initialized && this.child && !this.child.killed) return this;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this._start();
    try {
      await this.startPromise;
      return this;
    } finally {
      this.startPromise = null;
    }
  }

  async _start() {
    if (!this.command) {
      throw new Error(this.commandInfo?.detail || "Codex app-server command is not available.");
    }

    this.child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildCodexEnv()
    });

    const stdout = readline.createInterface({ input: this.child.stdout });
    const stderr = readline.createInterface({ input: this.child.stderr });

    stdout.on("line", (line) => this._handleLine(line));
    stderr.on("line", (line) => this.emit("stderr", line));

    this.child.on("error", (error) => {
      this.emit("error", error);
      this._rejectPending(error);
    });

    this.child.on("close", (code, signal) => {
      this.initialized = false;
      const reason = signal || (code ?? "unknown");
      const error = new Error(`Codex app-server exited (${reason})`);
      this.emit("close", { code, signal });
      this._rejectPending(error);
    });

    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "echo-codex",
          title: "Echo Codex",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      },
      15000
    );
    this.notify("initialized");
    this.initialized = true;
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("Codex app-server is not running."));
    }

    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    this._send(message);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timeout, method });
    });
  }

  notify(method, params = undefined) {
    if (!this.child?.stdin?.writable) return;
    this._send(params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    if (id === undefined || id === null) return;
    this._send({ id, result });
  }

  reject(id, code = -32603, message = "Request rejected by Echo Codex.") {
    if (id === undefined || id === null) return;
    this._send({ id, error: { code, message } });
  }

  stop() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.initialized = false;
    if (child.stdin?.writable) child.stdin.end();
    if (!child.killed) child.kill("SIGTERM");
  }

  _send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.emit("stderr", trimmed);
      return;
    }

    const id = message.id;
    const pending = id === undefined || id === null ? null : this.pending.get(String(id));
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(String(id));
      if (message.error) {
        pending.reject(new Error(message.error.message || `${pending.method} failed`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && id !== undefined && id !== null) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      return;
    }

    this.emit("message", message);
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function buildUserTextInput(text) {
  return {
    type: "text",
    text: String(text || ""),
    text_elements: []
  };
}

export function buildUserImageInput(url) {
  return {
    type: "image",
    url: String(url || "")
  };
}

export function buildUserLocalImageInput(filePath) {
  return {
    type: "localImage",
    path: String(filePath || "")
  };
}

export function buildUserInputs(text, attachments = []) {
  const inputs = [];
  const normalizedText = String(text || "").trim();
  if (normalizedText) inputs.push(buildUserTextInput(normalizedText));

  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (attachment?.type === "localImage") {
      const filePath = String(attachment.path || "").trim();
      if (!filePath) continue;
      inputs.push(buildUserLocalImageInput(filePath));
      continue;
    }
    if (attachment?.type !== "image") continue;
    const url = String(attachment.url || "").trim();
    if (!url) continue;
    inputs.push(buildUserImageInput(url));
  }

  return inputs;
}
