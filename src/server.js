import express from "express";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import multer from "multer";
import qrcode from "qrcode-terminal";
import { config } from "./config.js";
import { getLanUrls } from "./lib/network.js";
import { loadHistory, recentHistory, allHistory, addHistory } from "./lib/history.js";
import { getSttStatus, transcribeAudio } from "./lib/stt.js";
import { getRefineStatus, refineTranscript } from "./lib/refine.js";
import { insertText } from "./lib/paste.js";
import { ackInsertJob, enqueueInsertJob, failInsertJob, relayStatus, waitForInsertJob } from "./lib/relayQueue.js";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

await loadHistory();

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.use("/api", (req, res, next) => {
  const provided = req.get("x-echo-token") || req.query.token || req.body?.token;
  if (provided !== config.token) {
    return res.status(401).json({ error: "Invalid or missing pairing token." });
  }
  next();
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    mode: config.mode,
    stt: getSttStatus(),
    refine: getRefineStatus(),
    insertMode: config.insertMode,
    relay: config.mode === "relay" ? relayStatus() : null,
    platform: process.platform
  });
});

app.get("/api/history", (req, res) => {
  res.json({ items: allHistory(50) });
});

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing audio file." });
    }

    const mode = req.body.mode || "chat";
    const contextHint = req.body.contextHint || "";
    const raw = await transcribeAudio({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      originalName: req.file.originalname
    });

    const refined = await refineTranscript({
      rawText: raw,
      mode,
      contextHint,
      history: recentHistory(8)
    });

    const item = await addHistory({
      raw,
      refined,
      mode,
      contextHint
    });

    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/refine", async (req, res) => {
  try {
    const rawText = req.body.rawText || "";
    const mode = req.body.mode || "chat";
    const contextHint = req.body.contextHint || "";
    const refined = await refineTranscript({
      rawText,
      mode,
      contextHint,
      history: recentHistory(8)
    });
    const item = await addHistory({ raw: rawText, refined, mode, contextHint });
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/insert", async (req, res) => {
  try {
    const text = req.body.text || "";
    if (config.mode === "relay") {
      const job = enqueueInsertJob(text);
      return res.json({
        mode: "relay",
        queued: true,
        jobId: job.id,
        message: relayStatus().desktopOnline ? "已发送到桌面 agent。" : "已排队，桌面 agent 连接后会发送。"
      });
    }

    const result = await insertText(text);
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/agent/next", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Agent polling is only available in relay mode." });
    }

    const wait = Number(req.query.wait || 25000);
    const job = await waitForInsertJob(wait);
    res.json({ job });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/ack", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Agent acknowledgement is only available in relay mode." });
  }

  const ok = ackInsertJob(req.body.id, req.body.result || {});
  res.json({ ok });
});

app.post("/api/agent/fail", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Agent failure reporting is only available in relay mode." });
  }

  const ok = failInsertJob(req.body.id, req.body.error || "Unknown insertion error");
  res.json({ ok });
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
  const publicUrl = config.publicUrl ? `${config.publicUrl}/?token=${encodeURIComponent(config.token)}` : "";
  const urls = [
    ...(publicUrl ? [publicUrl] : []),
    ...getLanUrls(config.port, config.token, protocol)
  ];
  const androidUsbUrl = `http://localhost:${config.port}/?token=${encodeURIComponent(config.token)}`;
  console.log(`\nEcho Voice ${config.mode === "relay" ? "relay server" : "desktop agent"} is running.\n`);
  console.log("Open one of these URLs on your phone:\n");
  for (const url of urls) console.log(`  ${url}`);
  if (!useHttps && config.mode !== "relay") {
    console.log("\nAndroid microphone access needs HTTPS or localhost.");
    console.log("For USB development, run `npm run android:usb`, then open:");
    console.log(`  ${androidUsbUrl}`);
  }
  if (config.mode === "relay") {
    if (!config.publicUrl) {
      console.log("\nSet ECHO_PUBLIC_URL=https://YOUR_DOMAIN so the relay prints the correct phone URL.");
    }
    console.log("\nRun this on the computer that should receive text:");
    console.log(`  ECHO_RELAY_URL=${config.publicUrl || `${protocol}://YOUR_DOMAIN`} ECHO_TOKEN=${config.token} npm run desktop`);
  }
  const qrUrl = publicUrl || (useHttps ? urls[0] : androidUsbUrl);
  const qrLabel = publicUrl ? "the public URL" : useHttps ? "the first LAN URL" : "Android USB localhost";
  console.log(`\nPairing QR for ${qrLabel}:\n`);
  qrcode.generate(qrUrl, { small: true });
  console.log("\nKeep this terminal running while using the phone UI.\n");
});

function handleError(res, error) {
  const status = error.statusCode || 500;
  res.status(status).json({
    error: error.message || "Unexpected error"
  });
}
