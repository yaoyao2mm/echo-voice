import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import qrcode from "qrcode-terminal";
import { config } from "./config.js";
import { getLanUrls } from "./lib/network.js";
import { loadHistory, recentHistory, allHistory, addHistory } from "./lib/history.js";
import { getRefineStatus, refineTranscript } from "./lib/refine.js";
import {
  bearerToken,
  createSessionToken,
  findUser,
  publicUser,
  validatePassword,
  verifySessionToken
} from "./lib/auth.js";
import {
  appendCodexSessionEvents,
  archiveCodexSession,
  cancelCodexSession,
  codexStatus,
  compactCodexSession,
  completeCodexSessionCommand,
  completeCodexWorkspaceCommand,
  getCodexSessionAttachmentContent,
  createCodexSessionInteraction,
  createCodexSessionApproval,
  createCodexSession,
  createCodexWorkspace,
  decideCodexSessionInteraction,
  decideCodexSessionApproval,
  enqueueCodexSessionMessage,
  getCodexSession,
  getCodexWorkspaceCommand,
  listCodexSessions,
  subscribeCodexSession,
  waitForCodexSessionApproval,
  waitForCodexSessionInteraction,
  waitForCodexSessionCommand,
  waitForCodexWorkspaceCommand
} from "./lib/codexQueue.js";

const app = express();
const sseTickets = new Map();

await loadHistory();

app.use(express.json({ limit: "32mb" }));
app.use(express.static("public", {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
  }
}));

app.use("/api/codex/sessions/:id/events", (req, res, next) => {
  if (req.method !== "GET") return next();
  if (validateSseTicket(req.params.id, req.query.ticket)) {
    req.sseTicketAuthenticated = true;
  }
  next();
});

app.get("/api/auth/config", (req, res) => {
  res.json({ enabled: config.auth.enabled });
});

app.post("/api/auth/login", (req, res) => {
  if (!config.auth.enabled) {
    return res.json({
      user: { username: "local", displayName: "Local", role: "owner" },
      sessionToken: "",
      expiresAt: null
    });
  }

  const user = findUser(config.auth.users, req.body?.username);
  if (!validatePassword(user, req.body?.password)) {
    return res.status(401).json({
      code: "LOGIN_FAILED",
      error: "用户名或密码错误。"
    });
  }

  const sessionToken = createSessionToken({
    user,
    secret: config.auth.sessionSecret,
    ttlMs: config.auth.sessionTtlMs
  });
  res.json({
    user: publicUser(user),
    sessionToken,
    expiresAt: new Date(Date.now() + config.auth.sessionTtlMs).toISOString()
  });
});

app.get("/api/auth/me", (req, res) => {
  if (!config.auth.enabled) {
    return res.json({ user: { username: "local", displayName: "Local", role: "owner" } });
  }

  const user = currentSessionUser(req);
  if (!user) {
    return res.status(401).json({
      code: "SESSION_REQUIRED",
      error: "需要登录。"
    });
  }
  res.json({ user });
});

app.use("/api", (req, res, next) => {
  if (req.sseTicketAuthenticated) return next();

  const provided = req.get("x-echo-token") || req.query.token || req.body?.token;
  if (provided !== config.token) {
    return res.status(401).json({
      code: "PAIRING_REQUIRED",
      error: "配对 token 无效或缺失。"
    });
  }

  if (config.auth.enabled && !isAgentRequest(req)) {
    const user = currentSessionUser(req);
    if (!user) {
      return res.status(401).json({
        code: "SESSION_REQUIRED",
        error: "需要登录。"
      });
    }
    req.user = user;
  }
  next();
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    mode: config.mode,
    refine: getRefineStatus(),
    codex: config.mode === "relay" ? codexStatus() : null,
    user: req.user || null,
    platform: process.platform
  });
});

app.get("/api/history", (req, res) => {
  res.json({ items: allHistory(50) });
});

app.post("/api/refine", async (req, res) => {
  try {
    const rawText = req.body.rawText || "";
    const mode = req.body.mode || "chat";
    const contextHint = req.body.contextHint || "";
    const history = req.body.includeHistory === false ? [] : recentHistory(8);
    const refined = await refineTranscript({
      rawText,
      mode,
      contextHint,
      history
    });
    const item = await addHistory({ raw: rawText, refined, mode, contextHint, user: req.user || null });
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/agent/ping", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Agent ping is only available in relay mode." });
  }

  res.json({
    ok: true,
    mode: config.mode,
    refine: getRefineStatus(),
    codex: codexStatus()
  });
});

app.post("/api/agent/refine", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Agent refine test is only available in relay mode." });
    }

    const rawText = String(req.body.rawText || "").trim();
    if (!rawText) {
      return res.status(400).json({ error: "rawText is required." });
    }

    const refined = await refineTranscript({
      rawText,
      mode: req.body.mode || "chat",
      contextHint: req.body.contextHint || "桌面端配置页测试实际 relay 后处理",
      history: req.body.includeHistory === false ? [] : recentHistory(8)
    });
    res.json({
      ok: true,
      status: getRefineStatus(),
      refined
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/codex/status", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Codex remote control is only available in relay mode." });
  }

  res.json(codexStatus());
});

app.post("/api/codex/workspaces", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex workspace management is only available in relay mode." });
    }

    const command = createCodexWorkspace({
      name: req.body.name || req.body.label,
      requestedBy: req.user?.username || req.user?.displayName || "mobile"
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/codex/workspaces/:id", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Codex workspace management is only available in relay mode." });
  }

  const command = getCodexWorkspaceCommand(req.params.id);
  if (!command) return res.status(404).json({ error: "Codex workspace command not found." });
  res.json({ command });
});

app.get("/api/codex/sessions", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Codex interactive sessions are only available in relay mode." });
  }

  res.json({
    items: listCodexSessions(30, {
      archived: req.query.archived === "true",
      projectId: req.query.projectId
    })
  });
});

app.post("/api/codex/sessions", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex interactive sessions are only available in relay mode." });
    }

    const session = createCodexSession({
      projectId: req.body.projectId,
      prompt: req.body.prompt,
      attachments: req.body.attachments,
      runtime: req.body.runtime || {},
      mode: req.body.mode
    });
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/codex/sessions/:id", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Codex interactive sessions are only available in relay mode." });
  }

  const session = getCodexSession(req.params.id, streamSessionOptions({ initial: true }));
  if (!session) return res.status(404).json({ error: "Codex session not found." });
  res.json({ session });
});

app.post("/api/codex/sessions/:id/events-ticket", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Codex interactive session events are only available in relay mode." });
  }

  const session = getCodexSession(req.params.id, {
    includeMessages: false,
    includeApprovals: false,
    includeRaw: false,
    maxEvents: 1
  });
  if (!session) return res.status(404).json({ error: "Codex session not found." });

  const ticket = createSseTicket(req.params.id);
  res.json({
    ticket: ticket.id,
    expiresAt: ticket.expiresAt
  });
});

app.get("/api/codex/sessions/:id/events", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Codex interactive session events are only available in relay mode." });
  }
  if (!req.sseTicketAuthenticated) {
    return res.status(401).json({
      code: "SSE_TICKET_REQUIRED",
      error: "Session event stream ticket is invalid or expired."
    });
  }

  const session = getCodexSession(req.params.id, streamSessionOptions({ initial: true }));
  if (!session) return res.status(404).json({ error: "Codex session not found." });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");
  writeSse(res, "session", { session, partial: false });

  const unsubscribe = subscribeCodexSession(req.params.id, () => {
    const updated = getCodexSession(req.params.id, streamSessionOptions({ initial: false }));
    if (updated) writeSse(res, "session", { session: updated, partial: true });
  });
  const heartbeat = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 25000);
  heartbeat.unref?.();

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
  req.on("aborted", cleanup);
});

app.get("/api/codex/attachments/:id", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Codex attachments are only available in relay mode." });
  }

  sendCodexAttachment(req, res);
});

app.get("/api/agent/codex/attachments/:id", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Codex attachments are only available in relay mode." });
  }

  sendCodexAttachment(req, res);
});

app.post("/api/codex/sessions/:id/messages", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex interactive sessions are only available in relay mode." });
    }

    const session = enqueueCodexSessionMessage(req.params.id, {
      text: req.body.text || req.body.prompt,
      attachments: req.body.attachments,
      runtime: req.body.runtime || {},
      mode: req.body.mode,
      projectId: req.body.projectId
    });
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions/:id/compact", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex interactive sessions are only available in relay mode." });
    }

    const session = compactCodexSession(req.params.id, {
      automatic: req.body.automatic,
      reason: req.body.reason
    });
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions/:id/cancel", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex interactive sessions are only available in relay mode." });
    }

    const session = cancelCodexSession(req.params.id, {
      reason: req.body.reason
    });
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions/:id/archive", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex interactive sessions are only available in relay mode." });
    }

    const session = archiveCodexSession(req.params.id, {
      archived: req.body.archived !== false
    });
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions/:id/approvals/:approvalId", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex interactive approvals are only available in relay mode." });
    }

    const approval = decideCodexSessionApproval(
      req.params.approvalId,
      {
        sessionId: req.params.id,
        decision: req.body.decision
      },
      {
        user: req.user || null
      }
    );
    if (!approval) return res.status(404).json({ error: "Codex approval not found." });
    res.json({ approval });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions/:id/interactions/:interactionId", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex interactive requests are only available in relay mode." });
    }

    const interaction = decideCodexSessionInteraction(
      req.params.interactionId,
      {
        sessionId: req.params.id,
        decision: req.body.decision,
        answers: req.body.answers,
        response: req.body.response
      },
      {
        user: req.user || null
      }
    );
    if (!interaction) return res.status(404).json({ error: "Codex interaction not found." });
    res.json({ interaction });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/sessions/next", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex session agent polling is only available in relay mode." });
    }

    const command = await waitForCodexSessionCommand({
      waitMs: Number(req.query.wait || req.body.wait || 25000),
      agent: {
        id: req.body.agentId || req.body.agent?.id,
        workspaces: req.body.workspaces || [],
        runtime: req.body.runtime || {}
      }
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/workspaces/next", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex workspace agent polling is only available in relay mode." });
    }

    const command = await waitForCodexWorkspaceCommand({
      waitMs: Number(req.query.wait || req.body.wait || 25000),
      agent: {
        id: req.body.agentId || req.body.agent?.id,
        workspaces: req.body.workspaces || [],
        runtime: req.body.runtime || {}
      }
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/workspaces/commands/complete", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Codex workspace agent completion is only available in relay mode." });
  }

  const ok = completeCodexWorkspaceCommand(req.body.id, req.body.result || {}, {
    agent: {
      id: req.body.agentId || req.body.agent?.id,
      workspaces: req.body.workspaces || [],
      runtime: req.body.runtime || {}
    }
  });
  res.json({ ok });
});

app.post("/api/agent/codex/sessions/events", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Codex session agent events are only available in relay mode." });
  }

  const ok = appendCodexSessionEvents(req.body.id, req.body.events || [], {
    agentId: req.body.agentId
  });
  res.json({ ok });
});

app.post("/api/agent/codex/sessions/commands/complete", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Codex session agent completion is only available in relay mode." });
  }

  const ok = completeCodexSessionCommand(req.body.id, req.body.result || {}, {
    agentId: req.body.agentId
  });
  res.json({ ok });
});

app.post("/api/agent/codex/sessions/approvals", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex session approvals are only available in relay mode." });
    }

    const approval = createCodexSessionApproval(
      {
        sessionId: req.body.sessionId,
        appRequestId: req.body.appRequestId,
        method: req.body.method,
        prompt: req.body.prompt,
        payload: req.body.payload
      },
      {
        agentId: req.body.agentId
      }
    );
    res.json({ approval });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/sessions/approvals/:id/wait", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex session approval waiting is only available in relay mode." });
    }

    const approval = await waitForCodexSessionApproval(req.params.id, {
      waitMs: Number(req.query.wait || req.body.wait || 25000),
      agentId: req.body.agentId
    });
    res.json({ approval });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/sessions/interactions", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex session interactions are only available in relay mode." });
    }

    const interaction = createCodexSessionInteraction(
      {
        sessionId: req.body.sessionId,
        appRequestId: req.body.appRequestId,
        method: req.body.method,
        kind: req.body.kind,
        prompt: req.body.prompt,
        payload: req.body.payload
      },
      {
        agentId: req.body.agentId
      }
    );
    res.json({ interaction });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/sessions/interactions/:id/wait", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Codex session interaction waiting is only available in relay mode." });
    }

    const interaction = await waitForCodexSessionInteraction(req.params.id, {
      waitMs: Number(req.query.wait || req.body.wait || 25000),
      agentId: req.body.agentId,
      sessionId: req.body.sessionId
    });
    res.json({ interaction });
  } catch (error) {
    handleError(res, error);
  }
});

const useHttps = Boolean(config.httpsCert && config.httpsKey);
const server = useHttps
  ? https.createServer(
      {
        cert: fs.readFileSync(config.httpsCert),
        key: fs.readFileSync(config.httpsKey)
      },
      app
    )
  : http.createServer(app);

server.listen(config.port, config.host, () => {
  const protocol = useHttps ? "https" : "http";
  const publicUrl = config.publicUrl || "";
  const publicPairingUrl = publicUrl ? `${publicUrl}/?token=${encodeURIComponent(config.token)}` : "";
  const urls =
    config.mode === "relay"
      ? [publicUrl || `${protocol}://YOUR_DOMAIN`]
      : [...(publicPairingUrl ? [publicPairingUrl] : []), ...getLanUrls(config.port, config.token, protocol)];
  const androidUsbUrl = `http://localhost:${config.port}/?token=${encodeURIComponent(config.token)}`;
  console.log(`\nEcho Codex ${config.mode === "relay" ? "relay server" : "desktop agent"} is running.\n`);
  console.log("Open one of these URLs on your phone:\n");
  for (const url of urls) console.log(`  ${url}`);
  if (!useHttps && config.mode !== "relay") {
    console.log("\nAndroid QR camera pairing needs HTTPS or localhost.");
    console.log("For USB development, run `pnpm run android:usb`, then open:");
    console.log(`  ${androidUsbUrl}`);
  }
  if (config.mode === "relay") {
    if (!config.publicUrl) {
      console.log("\nSet ECHO_PUBLIC_URL=https://YOUR_DOMAIN so the relay prints the correct phone URL.");
    }
    console.log("\nRun this on the computer that should run local Codex:");
    console.log(`  ECHO_RELAY_URL=${config.publicUrl || `${protocol}://YOUR_DOMAIN`} ECHO_TOKEN=<pairing-token> pnpm run desktop`);
  }
  if (config.mode !== "relay") {
    const qrUrl = publicPairingUrl || (useHttps ? urls[0] : androidUsbUrl);
    const qrLabel = publicPairingUrl ? "the public URL" : useHttps ? "the first LAN URL" : "Android USB localhost";
    console.log(`\nPairing QR for ${qrLabel}:\n`);
    qrcode.generate(qrUrl, { small: true });
  } else {
    console.log("\nRelay mode does not print pairing tokens. Use the desktop settings QR or your saved ECHO_TOKEN.");
  }
  console.log("\nKeep this terminal running while using the phone UI.\n");
});

function handleError(res, error) {
  const status = error.statusCode || 500;
  res.status(status).json({
    error: error.message || "Unexpected error"
  });
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamSessionOptions({ initial = false } = {}) {
  return {
    rawMode: "client",
    maxEvents: initial ? 160 : 80,
    includeMessages: initial,
    includeApprovals: true,
    includeInteractions: true
  };
}

function createSseTicket(sessionId) {
  pruneSseTickets();
  const id = crypto.randomBytes(24).toString("base64url");
  const expiresAtMs = Date.now() + 2 * 60 * 1000;
  const ticket = {
    id,
    sessionId: String(sessionId || ""),
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString()
  };
  sseTickets.set(id, ticket);
  return ticket;
}

function validateSseTicket(sessionId, ticketId) {
  pruneSseTickets();
  const ticket = sseTickets.get(String(ticketId || ""));
  if (!ticket) return false;
  if (ticket.sessionId !== String(sessionId || "")) return false;
  if (ticket.expiresAtMs < Date.now()) {
    sseTickets.delete(ticket.id);
    return false;
  }
  return true;
}

function pruneSseTickets() {
  const now = Date.now();
  for (const ticket of sseTickets.values()) {
    if (ticket.expiresAtMs < now) sseTickets.delete(ticket.id);
  }
}

function sendCodexAttachment(req, res) {
  const attachment = getCodexSessionAttachmentContent(req.params.id);
  if (!attachment) return res.status(404).json({ error: "Codex attachment not found." });
  if (!fs.existsSync(attachment.filePath)) {
    return res.status(410).json({ error: "Codex attachment file is no longer available." });
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.type(attachment.mimeType || "application/octet-stream");
  res.sendFile(attachment.filePath);
}

function currentSessionUser(req) {
  return verifySessionToken({
    token: bearerToken(req),
    users: config.auth.users,
    secret: config.auth.sessionSecret
  });
}

function isAgentRequest(req) {
  const path = req.originalUrl.split("?")[0];
  return path.startsWith("/api/agent/");
}
