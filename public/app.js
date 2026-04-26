const params = new URLSearchParams(window.location.search);
const tokenFromUrl = params.get("token");
if (tokenFromUrl) localStorage.setItem("echoToken", tokenFromUrl);
const token = tokenFromUrl || localStorage.getItem("echoToken") || "";

const elements = {
  statusText: document.querySelector("#statusText"),
  refreshStatus: document.querySelector("#refreshStatus"),
  modes: Array.from(document.querySelectorAll(".mode")),
  contextHint: document.querySelector("#contextHint"),
  recordButton: document.querySelector("#recordButton"),
  recordLabel: document.querySelector("#recordLabel"),
  rawText: document.querySelector("#rawText"),
  finalText: document.querySelector("#finalText"),
  refineButton: document.querySelector("#refineButton"),
  copyButton: document.querySelector("#copyButton"),
  sendButton: document.querySelector("#sendButton"),
  history: document.querySelector("#history")
};

let mode = "chat";
let mediaRecorder = null;
let chunks = [];
let recordingStartedAt = 0;
let serverStatus = null;
let recognition = null;
let browserSpeechActive = false;
let browserSpeechFinalText = "";
let recognitionStopRequested = false;

elements.refreshStatus.addEventListener("click", refreshStatus);
elements.recordButton.addEventListener("click", toggleRecording);
elements.refineButton.addEventListener("click", refineCurrentText);
elements.copyButton.addEventListener("click", copyFinalText);
elements.sendButton.addEventListener("click", sendToCursor);

for (const button of elements.modes) {
  button.addEventListener("click", () => {
    mode = button.dataset.mode;
    elements.modes.forEach((item) => item.classList.toggle("active", item === button));
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

await refreshStatus();
await loadHistory();

async function refreshStatus() {
  try {
    const status = await apiGet("/api/status");
    serverStatus = status;
    const stt = status.stt.provider === "none" ? "未配置转写" : `转写 ${status.stt.provider}`;
    const effectiveStt = status.stt.provider === "none" && supportsBrowserSpeechRecognition() ? "浏览器转写" : stt;
    const refine = status.refine.provider === "none" ? "不整理" : `整理 ${status.refine.provider}`;
    const relay = status.mode === "relay"
      ? status.relay?.desktopOnline
        ? "桌面在线"
        : "桌面离线"
      : status.platform;
    elements.statusText.textContent = `${effectiveStt} · ${refine} · ${relay}`;
  } catch (error) {
    elements.statusText.textContent = token ? "连接失败" : "缺少配对 token";
    toast(error.message);
  }
}

async function toggleRecording() {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
    return;
  }

  if (!window.isSecureContext) {
    toast("手机录音需要 HTTPS，或通过 adb reverse 打开 localhost URL");
    return;
  }

  if (shouldUseBrowserSpeech()) {
    toggleBrowserSpeech();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = bestMimeType();
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks = [];

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    mediaRecorder.addEventListener("stop", async () => {
      stream.getTracks().forEach((track) => track.stop());
      setRecording(false);
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" });
      await submitAudio(blob);
    });

    recordingStartedAt = Date.now();
    mediaRecorder.start();
    setRecording(true);
  } catch (error) {
    toast(error.message);
  }
}

function shouldUseBrowserSpeech() {
  return serverStatus?.stt?.provider === "none" && supportsBrowserSpeechRecognition();
}

function supportsBrowserSpeechRecognition() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function toggleBrowserSpeech() {
  if (browserSpeechActive) {
    recognitionStopRequested = true;
    recognition?.stop();
    return;
  }

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new Recognition();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;
  browserSpeechFinalText = elements.rawText.value.trim();
  recognitionStopRequested = false;

  recognition.onstart = () => {
    browserSpeechActive = true;
    recordingStartedAt = Date.now();
    setRecording(true);
  };

  recognition.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript || "";
      if (event.results[index].isFinal) {
        browserSpeechFinalText = `${browserSpeechFinalText}${transcript}`.trim();
      } else {
        interim += transcript;
      }
    }
    elements.rawText.value = [browserSpeechFinalText, interim].filter(Boolean).join("\n");
  };

  recognition.onerror = (event) => {
    toast(event.error || "浏览器转写失败");
  };

  recognition.onend = async () => {
    browserSpeechActive = false;
    setRecording(false);
    const raw = browserSpeechFinalText.trim() || elements.rawText.value.trim();
    if (recognitionStopRequested && raw) {
      elements.rawText.value = raw;
      await refineCurrentText();
    }
  };

  recognition.start();
}

function setRecording(isRecording) {
  elements.recordButton.classList.toggle("recording", isRecording);
  elements.recordLabel.textContent = isRecording ? "再次按下结束" : "按下说话";
}

async function submitAudio(blob) {
  const seconds = Math.round((Date.now() - recordingStartedAt) / 1000);
  if (seconds < 1 || blob.size < 1024) {
    toast("录音太短");
    return;
  }

  setBusy(true, "转写中");

  try {
    const form = new FormData();
    form.append("audio", blob, filenameFor(blob.type));
    form.append("mode", mode);
    form.append("contextHint", elements.contextHint.value);

    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: authHeaders(),
      body: form
    });
    const data = await parseApiResponse(response);
    applyItem(data.item);
    await loadHistory();
    toast("已整理");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function refineCurrentText() {
  const rawText = elements.rawText.value.trim() || elements.finalText.value.trim();
  if (!rawText) {
    toast("没有可整理的文本");
    return;
  }

  setBusy(true, "整理中");
  try {
    const data = await apiPost("/api/refine", {
      rawText,
      mode,
      contextHint: elements.contextHint.value
    });
    applyItem(data.item);
    await loadHistory();
    toast("已更新");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function copyFinalText() {
  const text = elements.finalText.value.trim();
  if (!text) {
    toast("没有可复制的文本");
    return;
  }
  await navigator.clipboard.writeText(text);
  toast("已复制");
}

async function sendToCursor() {
  const text = elements.finalText.value.trim();
  if (!text) {
    toast("没有可发送的文本");
    return;
  }

  setBusy(true, "发送中");
  try {
    const result = await apiPost("/api/insert", { text });
    toast(result.message || "已发送");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(false);
  }
}

async function loadHistory() {
  try {
    const data = await apiGet("/api/history");
    elements.history.innerHTML = "";
    for (const item of data.items.slice(0, 8)) {
      const wrapper = document.createElement("div");
      wrapper.className = "history-item";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.refined || item.raw || "";
      button.addEventListener("click", () => applyItem(item));
      wrapper.append(button);
      elements.history.append(wrapper);
    }
  } catch {
    elements.history.innerHTML = "";
  }
}

function applyItem(item) {
  elements.rawText.value = item.raw || "";
  elements.finalText.value = item.refined || "";
}

function setBusy(isBusy, label = "") {
  for (const button of [elements.recordButton, elements.refineButton, elements.copyButton, elements.sendButton]) {
    button.disabled = isBusy;
  }
  if (label) elements.statusText.textContent = label;
  if (!isBusy) refreshStatus();
}

function authHeaders() {
  return token ? { "X-Echo-Token": token } : {};
}

async function apiGet(path) {
  const response = await fetch(path, { headers: authHeaders() });
  return parseApiResponse(response);
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify(body)
  });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function bestMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

function filenameFor(mimeType) {
  if (mimeType.includes("ogg")) return "recording.ogg";
  if (mimeType.includes("mp4")) return "recording.m4a";
  return "recording.webm";
}

function toast(message) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.append(node);
  window.setTimeout(() => node.remove(), 2600);
}
