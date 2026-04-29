const params = new URLSearchParams(window.location.search);
const settingsKey = params.get("key") || "";
const form = document.querySelector("#settingsForm");
const output = document.querySelector("#output");
const envPath = document.querySelector("#envPath");
const healthGrid = document.querySelector("#healthGrid");
const pairingQr = document.querySelector("#pairingQr");
const workspaceRows = document.querySelector("#workspaceRows");
const workspaceRaw = document.querySelector('[data-key="ECHO_CODEX_WORKSPACES"]');
const workspaceSuggestions = document.querySelector("#workspaceSuggestions");
const directoryBrowser = document.querySelector("#directoryBrowser");
const directoryEntries = document.querySelector("#directoryEntries");
const directoryPath = document.querySelector("#directoryPath");
const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");

let pairingUrl = "";
let workspaceHealthItems = [];
let directoryBrowserPath = "";
let directoryBrowserHome = "";
let directoryTargetInput = null;

if (!settingsKey) {
  writeOutput("Missing local settings key.", true);
} else {
  bindEvents();
  await loadState();
}

function bindEvents() {
  for (const tab of tabs) {
    tab.addEventListener("click", () => showPanel(tab.dataset.tab));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveConfig();
  });

  document.querySelector("#networkTest").addEventListener("click", () => runAction("/api/test/network", "Testing network..."));
  document.querySelector("#refineTest").addEventListener("click", () =>
    runAction("/api/test/refine", "Testing refinement...", {
      text: "嗯我想把这个需求整理成适合 Codex 执行的任务，不要太啰嗦。"
    })
  );
  document.querySelector("#restartAgent").addEventListener("click", () => runAction("/api/desktop/restart", "Restarting desktop agent..."));
  document.querySelector("#reloadState").addEventListener("click", loadState);
  document.querySelector("#refreshHealth").addEventListener("click", loadHealth);
  document.querySelector("#refreshPairingQr").addEventListener("click", loadPairing);
  document.querySelector("#copyPairingUrl").addEventListener("click", copyPairingUrl);
  document.querySelector("#addWorkspace").addEventListener("click", () => addWorkspaceRow());
  document.querySelector("#discoverWorkspaces").addEventListener("click", discoverWorkspaces);
  document.querySelector("#browseWorkspaceRoot").addEventListener("click", () => openDirectoryBrowser());
  document.querySelector("#browseHome").addEventListener("click", () => loadDirectory(directoryBrowserHome));
  document.querySelector("#browseParent").addEventListener("click", () => loadDirectoryParent());
  document.querySelector("#selectCurrentDirectory").addEventListener("click", () => chooseDirectory(directoryBrowserPath));
}

function showPanel(name) {
  for (const tab of tabs) tab.classList.toggle("active", tab.dataset.tab === name);
  for (const panel of panels) panel.classList.toggle("active", panel.dataset.panel === name);
}

async function loadState() {
  try {
    const state = await apiGet("/api/state");
    envPath.textContent = state.envFile;
    fillForm(state.fields);
    workspaceHealthItems = state.health?.workspaces?.items || [];
    renderWorkspaceRows(parseWorkspaceValue(valueOf(state.fields, "ECHO_CODEX_WORKSPACES")));
    renderHealth(state.health);
    await loadPairing();
    writeOutput(formatState(state));
  } catch (error) {
    writeOutput(error.message, true);
  }
}

async function loadPairing() {
  if (!pairingQr) return;
  try {
    pairingQr.textContent = "Loading...";
    const pairing = await apiGet("/api/pairing");
    pairingUrl = pairing.mobileUrl;
    pairingQr.innerHTML = pairing.qrSvg;
  } catch (error) {
    pairingUrl = "";
    pairingQr.textContent = error.message;
  }
}

async function copyPairingUrl() {
  if (!pairingUrl) {
    await loadPairing();
  }
  if (!pairingUrl) {
    writeOutput("Pairing URL is not available.", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(pairingUrl);
    writeOutput("Pairing URL copied.");
  } catch (error) {
    writeOutput(error.message || "Could not copy pairing URL. Select it from the QR panel instead.", true);
  }
}

async function loadHealth() {
  try {
    const state = await apiGet("/api/desktop/health");
    workspaceHealthItems = state.health?.workspaces?.items || [];
    renderWorkspaceStatuses();
    renderHealth(state.health);
    writeOutput("Health refreshed.");
  } catch (error) {
    writeOutput(error.message, true);
  }
}

function renderHealth(health) {
  if (!healthGrid || !health) return;

  const items = [
    {
      title: "Relay",
      ok: health.connection?.ok,
      status: health.connection?.ok ? "ready" : "missing config",
      detail: [
        health.connection?.relayUrl || "No relay URL",
        health.connection?.tokenSet ? "token set" : "token missing",
        `proxy: ${health.connection?.proxy || "direct"}`
      ].join("\n")
    },
    {
      title: "Desktop Agent",
      ok: health.agent?.ok,
      status: health.agent?.status || "unknown",
      detail: health.agent?.detail || "",
      actions: [
        { label: "Restart", path: "/api/desktop/restart", pending: "Restarting desktop agent..." }
      ]
    },
    {
      title: "Codex CLI",
      ok: health.codex?.ok,
      status: health.codex?.status || "unknown",
      detail: [health.codex?.path, health.codex?.version, health.codex?.detail].filter(Boolean).join("\n")
    },
    {
      title: "Workspaces",
      ok: health.workspaces?.ok,
      status: health.workspaces?.ok ? "ready" : "check paths",
      detail: (health.workspaces?.items || [])
        .map((item) => `${item.ok ? "OK" : "NO"} ${item.label}: ${item.path}`)
        .join("\n")
    }
  ];

  healthGrid.replaceChildren(...items.map(renderHealthItem));
}

function renderHealthItem(item) {
  const root = document.createElement("div");
  root.className = "healthItem";

  const top = document.createElement("div");
  top.className = "healthTop";

  const title = document.createElement("div");
  title.className = "healthTitle";
  title.textContent = item.title;

  const pill = document.createElement("span");
  pill.className = `pill${item.ok ? "" : " bad"}`;
  pill.textContent = item.status;

  top.append(title, pill);

  const detail = document.createElement("div");
  detail.className = "healthDetail";
  detail.textContent = item.detail || "";

  root.append(top, detail);

  if (item.actions?.length) {
    const actions = document.createElement("div");
    actions.className = "healthActions";
    for (const action of item.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", () => runAction(action.path, action.pending, action.body || {}));
      actions.append(button);
    }
    root.append(actions);
  }

  return root;
}

function fillForm(fields) {
  for (const input of form.querySelectorAll("[data-key]")) {
    const key = input.dataset.key;
    const field = fields[key];
    if (!field) continue;

    if (input.type === "checkbox") {
      input.checked = field.value === "true";
    } else if (input.dataset.secret === "true") {
      input.value = "";
      input.placeholder = field.set ? "已设置，留空保持" : "未设置";
    } else {
      input.value = field.value || "";
    }
  }

  for (const state of form.querySelectorAll("[data-secret-state]")) {
    const key = state.dataset.secretState;
    state.textContent = fields[key]?.set ? "已设置" : "未设置";
  }

  for (const clear of form.querySelectorAll("[data-clear-secret]")) clear.checked = false;
}

async function saveConfig() {
  const values = {};
  const clearSecrets = {};

  const workspaceValidation = validateWorkspaceRows();
  if (!workspaceValidation.ok) {
    writeOutput(workspaceValidation.message, true);
    showPanel("codex");
    return;
  }
  workspaceRaw.value = serializeWorkspaceRows();

  for (const input of form.querySelectorAll("[data-key]")) {
    const key = input.dataset.key;
    values[key] = input.type === "checkbox" ? input.checked : input.value;
  }

  for (const clear of form.querySelectorAll("[data-clear-secret]")) {
    clearSecrets[clear.dataset.clearSecret] = clear.checked;
  }

  try {
    writeOutput("Saving...");
    const result = await apiPost("/api/config", { values, clearSecrets });
    fillForm(result.fields);
    renderWorkspaceRows(parseWorkspaceValue(valueOf(result.fields, "ECHO_CODEX_WORKSPACES")));
    await loadPairing();
    writeOutput("Saved. Restart the desktop agent for running services to pick up the new config.");
  } catch (error) {
    writeOutput(error.message, true);
  }
}

async function runAction(path, pendingText, body = {}) {
  try {
    writeOutput(pendingText);
    const result = await apiPost(path, body);
    writeOutput(formatCommandResult(result));
  } catch (error) {
    writeOutput(error.message, true);
  }
}

async function apiGet(path) {
  const response = await fetch(path, {
    headers: {
      "X-Echo-Settings-Key": settingsKey
    }
  });
  return parseApiResponse(response);
}

async function apiPost(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Echo-Settings-Key": settingsKey
    },
    body: JSON.stringify(body)
  });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}

function formatState(state) {
  const fields = state.fields;
  const lines = [
    "Loaded",
    `env: ${state.envFile}`,
    `relay: ${valueOf(fields, "ECHO_RELAY_URL") || "-"}`,
    `proxy: ${valueOf(fields, "ECHO_PROXY_URL") || "direct"}`,
    `postprocess: ${state.meta?.postprocessScope || "local"}`,
    `local refine: ${valueOf(fields, "POSTPROCESS_PROVIDER") || "auto"}`,
    `codex: ${valueOf(fields, "ECHO_CODEX_ENABLED") || "true"}`
  ];
  return lines.join("\n");
}

function formatCommandResult(result) {
  const lines = [];
  lines.push(result.ok ? "OK" : `Failed (${result.code})`);
  if (result.stdout) lines.push("", result.stdout);
  if (result.stderr) lines.push("", result.stderr);
  return lines.join("\n").trim();
}

function valueOf(fields, key) {
  return fields[key]?.value || "";
}

function parseWorkspaceValue(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [label, rawPath] = item.includes("=") ? item.split("=", 2) : ["", item];
      const path = (rawPath || label || "").trim();
      return {
        label: (rawPath ? label : "").trim() || defaultWorkspaceLabel(path),
        path
      };
    });
}

function renderWorkspaceRows(items) {
  workspaceRows.replaceChildren();
  if (!items.length) {
    workspaceRows.append(renderWorkspaceEmpty());
    addWorkspaceRow({ label: "echo", path: "" });
    return;
  }

  for (const item of items) addWorkspaceRow(item);
  renderWorkspaceStatuses();
}

function renderWorkspaceEmpty() {
  const node = document.createElement("div");
  node.className = "workspaceEmpty";
  node.textContent = "还没有授权工程目录。添加至少一个目录后，手机端才能选择项目。";
  return node;
}

function addWorkspaceRow(item = {}) {
  workspaceRows.querySelector(".workspaceEmpty")?.remove();

  const row = document.createElement("div");
  row.className = "workspaceRow";

  const labelField = document.createElement("label");
  labelField.className = "workspaceField";
  const labelTitle = document.createElement("span");
  labelTitle.textContent = "项目名";
  const labelInput = document.createElement("input");
  labelInput.dataset.workspaceLabel = "true";
  labelInput.placeholder = "echo";
  labelInput.value = item.label || defaultWorkspaceLabel(item.path || "");
  labelField.append(labelTitle, labelInput);

  const pathField = document.createElement("label");
  pathField.className = "workspaceField";
  const pathTitle = document.createElement("span");
  pathTitle.textContent = "本机路径";
  const pathInput = document.createElement("input");
  pathInput.dataset.workspacePath = "true";
  pathInput.placeholder = "/Users/john/workspace/projects/echo";
  pathInput.value = item.path || "";
  pathInput.addEventListener("input", () => {
    if (!labelInput.value.trim()) labelInput.value = defaultWorkspaceLabel(pathInput.value);
    renderWorkspaceStatuses();
  });
  pathField.append(pathTitle, pathInput);

  const actions = document.createElement("div");
  actions.className = "workspaceRowActions";

  const browseButton = document.createElement("button");
  browseButton.type = "button";
  browseButton.textContent = "浏览";
  browseButton.addEventListener("click", () => openDirectoryBrowser(pathInput));

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.textContent = "删除";
  removeButton.addEventListener("click", () => {
    row.remove();
    if (!workspaceRows.querySelector(".workspaceRow")) workspaceRows.append(renderWorkspaceEmpty());
  });
  actions.append(browseButton, removeButton);

  const status = document.createElement("div");
  status.className = "workspaceStatus";
  status.dataset.workspaceStatus = "true";

  row.append(labelField, pathField, actions, status);
  workspaceRows.append(row);
  renderWorkspaceStatuses();
}

function workspaceRowsData() {
  return Array.from(workspaceRows.querySelectorAll(".workspaceRow"))
    .map((row) => ({
      label: row.querySelector("[data-workspace-label]")?.value.trim() || "",
      path: row.querySelector("[data-workspace-path]")?.value.trim() || "",
      row
    }))
    .filter((item) => item.label || item.path);
}

function serializeWorkspaceRows() {
  return workspaceRowsData()
    .map((item) => `${item.label || defaultWorkspaceLabel(item.path)}=${item.path}`)
    .join(",");
}

function validateWorkspaceRows() {
  const rows = workspaceRowsData();
  if (!rows.length) return { ok: false, message: "请至少添加一个 Codex 工程目录。" };

  const labels = new Set();
  for (const item of rows) {
    if (!item.path) return { ok: false, message: "每个工程目录都需要填写本机路径。" };
    const label = item.label || defaultWorkspaceLabel(item.path);
    if (!label) return { ok: false, message: "每个工程目录都需要项目名。" };
    const id = label.toLowerCase();
    if (labels.has(id)) return { ok: false, message: `项目名重复：${label}` };
    labels.add(id);
  }

  return { ok: true, message: "" };
}

function renderWorkspaceStatuses() {
  const healthByLabel = new Map(workspaceHealthItems.map((item) => [String(item.label || "").trim(), item]));
  const healthByPath = new Map(workspaceHealthItems.map((item) => [String(item.path || "").trim(), item]));
  for (const item of workspaceRowsData()) {
    const status = item.row.querySelector("[data-workspace-status]");
    const health = healthByPath.get(item.path) || healthByLabel.get(item.label);
    status.classList.remove("ok", "bad");
    if (!item.path) {
      status.textContent = "填写本机绝对路径。";
      return;
    }
    if (!health) {
      status.textContent = "保存后刷新状态检查目录。";
      return;
    }
    status.textContent = health.ok ? "目录存在，手机端可选择。" : health.detail || "目录不可用。";
    status.classList.add(health.ok ? "ok" : "bad");
  }
}

async function discoverWorkspaces() {
  try {
    workspaceSuggestions.hidden = false;
    workspaceSuggestions.textContent = "正在发现工程...";
    const data = await apiGet("/api/workspaces/suggestions");
    renderWorkspaceSuggestions(data.items || []);
    writeOutput(`Found ${(data.items || []).length} workspace suggestions.`);
  } catch (error) {
    workspaceSuggestions.hidden = false;
    workspaceSuggestions.textContent = error.message;
    writeOutput(error.message, true);
  }
}

function renderWorkspaceSuggestions(items) {
  workspaceSuggestions.replaceChildren();
  workspaceSuggestions.hidden = false;
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "workspaceEmpty";
    empty.textContent = "没有发现工程。可以用“浏览目录”手动选择。";
    workspaceSuggestions.append(empty);
    return;
  }

  for (const item of items) {
    const root = document.createElement("div");
    root.className = "suggestionItem";

    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "suggestionTitle";
    title.textContent = item.label;
    const meta = document.createElement("div");
    meta.className = "suggestionMeta";
    meta.textContent = [item.path, item.signals?.length ? item.signals.join(" · ") : "", item.alreadyConfigured ? "已添加" : ""]
      .filter(Boolean)
      .join("\n");
    body.append(title, meta);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.alreadyConfigured || hasWorkspacePath(item.path) ? "已添加" : "加入";
    button.disabled = item.alreadyConfigured || hasWorkspacePath(item.path);
    button.addEventListener("click", () => {
      addWorkspaceRow({
        label: uniqueWorkspaceLabel(item.label),
        path: item.path
      });
      button.textContent = "已添加";
      button.disabled = true;
      writeOutput(`Added workspace: ${item.path}`);
    });

    root.append(body, button);
    workspaceSuggestions.append(root);
  }
}

async function openDirectoryBrowser(targetInput = null) {
  directoryTargetInput = targetInput;
  const start = targetInput?.value.trim() || firstWorkspaceParent() || "";
  await loadDirectory(start);
}

async function loadDirectory(path) {
  try {
    directoryBrowser.hidden = false;
    directoryEntries.textContent = "Loading...";
    const data = await apiGet(`/api/system/directories?path=${encodeURIComponent(path || "")}`);
    directoryBrowserPath = data.current;
    directoryBrowserHome = data.home;
    directoryPath.textContent = data.current;
    renderDirectoryEntries(data.entries || []);
  } catch (error) {
    directoryEntries.textContent = error.message;
    writeOutput(error.message, true);
  }
}

function loadDirectoryParent() {
  if (!directoryBrowserPath) return;
  const parts = directoryBrowserPath.split("/").filter(Boolean);
  if (parts.length === 0) return;
  loadDirectory(`/${parts.slice(0, -1).join("/")}`);
}

function renderDirectoryEntries(entries) {
  directoryEntries.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "workspaceEmpty";
    empty.textContent = "这个目录下面没有可进入的子目录。";
    directoryEntries.append(empty);
    return;
  }

  for (const entry of entries) {
    const root = document.createElement("div");
    root.className = "directoryItem";

    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "directoryTitle";
    title.textContent = entry.name;
    const meta = document.createElement("div");
    meta.className = "directoryMeta";
    meta.textContent = [entry.path, entry.signals?.length ? entry.signals.join(" · ") : ""].filter(Boolean).join("\n");
    body.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "directoryActions";
    const enter = document.createElement("button");
    enter.type = "button";
    enter.textContent = "进入";
    enter.addEventListener("click", () => loadDirectory(entry.path));
    const choose = document.createElement("button");
    choose.type = "button";
    choose.textContent = "选择";
    choose.addEventListener("click", () => chooseDirectory(entry.path));
    actions.append(enter, choose);

    root.append(body, actions);
    directoryEntries.append(root);
  }
}

function chooseDirectory(path) {
  if (!path) return;
  if (directoryTargetInput) {
    directoryTargetInput.value = path;
    const row = directoryTargetInput.closest(".workspaceRow");
    const labelInput = row?.querySelector("[data-workspace-label]");
    if (labelInput && !labelInput.value.trim()) labelInput.value = uniqueWorkspaceLabel(defaultWorkspaceLabel(path));
  } else if (!hasWorkspacePath(path)) {
    addWorkspaceRow({
      label: uniqueWorkspaceLabel(defaultWorkspaceLabel(path)),
      path
    });
  }
  directoryBrowser.hidden = true;
  renderWorkspaceStatuses();
  writeOutput(`Selected workspace: ${path}`);
}

function firstWorkspaceParent() {
  const first = workspaceRowsData().find((item) => item.path)?.path || "";
  if (!first || !first.includes("/")) return "";
  return first.split("/").slice(0, -1).join("/") || "/";
}

function hasWorkspacePath(path) {
  const target = normalizePath(path);
  return workspaceRowsData().some((item) => normalizePath(item.path) === target);
}

function uniqueWorkspaceLabel(label) {
  const base = String(label || "workspace").trim() || "workspace";
  const used = new Set(workspaceRowsData().map((item) => item.label.toLowerCase()).filter(Boolean));
  if (!used.has(base.toLowerCase())) return base;
  for (let index = 2; index < 100; index += 1) {
    const next = `${base}-${index}`;
    if (!used.has(next.toLowerCase())) return next;
  }
  return `${base}-${Date.now()}`;
}

function normalizePath(value) {
  return String(value || "").trim().replace(/\/+$/g, "");
}

function defaultWorkspaceLabel(value) {
  const text = String(value || "").trim().replace(/\\+$/g, "").replace(/\/+$/g, "");
  if (!text) return "";
  return text.split(/[\\/]/).filter(Boolean).pop() || "workspace";
}

function writeOutput(text, isError = false) {
  output.textContent = text || "";
  output.classList.toggle("error", Boolean(isError));
}
