const params = new URLSearchParams(window.location.search);
const settingsKey = params.get("key") || "";
const form = document.querySelector("#settingsForm");
const output = document.querySelector("#output");
const envPath = document.querySelector("#envPath");
const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");

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
    writeOutput(formatState(state));
  } catch (error) {
    writeOutput(error.message, true);
  }
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
    } else if (key === "ECHO_CODEX_WORKSPACES") {
      input.value = String(field.value || "").split(",").join("\n");
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

function writeOutput(text, isError = false) {
  output.textContent = text || "";
  output.classList.toggle("error", Boolean(isError));
}
