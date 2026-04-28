import { config } from "./config.js";
import { publicCodexRuntime, publicWorkspaces, runCodexJob } from "./lib/codexRunner.js";
import { describeHttpNetwork, formatFetchError, httpFetch } from "./lib/http.js";
import { insertText } from "./lib/paste.js";

if (!config.relayUrl) {
  console.error("Missing ECHO_RELAY_URL. Example: ECHO_RELAY_URL=https://voice.example.com ECHO_TOKEN=... npm run desktop");
  process.exit(1);
}

if (!config.token) {
  console.error("Missing ECHO_TOKEN. Use the same token as the relay server.");
  process.exit(1);
}

console.log("Echo Voice desktop agent is running.");
console.log(`Relay: ${config.relayUrl}`);
console.log(`Insert mode: ${config.insertMode}`);
console.log(`Network: ${formatNetworkStatus(describeHttpNetwork(config.relayUrl))}`);
console.log(`Codex remote: ${config.codex.enabled ? "enabled" : "disabled"}`);
if (config.codex.enabled) {
  const runtime = publicCodexRuntime();
  console.log(`  command: ${runtime.command}`);
  console.log(`  model: ${runtime.model || "Codex default"}`);
  console.log(`  sandbox: ${runtime.sandbox}`);
  for (const workspace of publicWorkspaces()) {
    console.log(`  ${workspace.id}: ${workspace.path}`);
  }
}
console.log("Keep the target app focused before sending text from the phone.\n");

runInsertLoop();
if (config.codex.enabled) runCodexLoop();

async function runInsertLoop() {
  while (true) {
    let job = null;
    try {
      job = await pollNextInsertJob();
      if (!job) continue;

      console.log(`[${new Date().toLocaleTimeString()}] inserting ${job.text.length} chars`);
      const result = await insertText(job.text);
      await postJson("/api/agent/ack", { id: job.id, result });
      console.log(`  ${result.message}`);
    } catch (error) {
      console.error(`[insert ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}`);
      if (job?.id) {
        await postJson("/api/agent/fail", { id: job.id, error: error.message }).catch(() => {});
      }
      await sleep(2500);
    }
  }
}

async function runCodexLoop() {
  while (true) {
    let job = null;
    try {
      job = await pollNextCodexJob();
      if (!job) continue;

      console.log(`[${new Date().toLocaleTimeString()}] codex ${job.id} in ${job.projectId}`);
      const result = await runCodexJob(job, {
        onEvents: (events) => postJson("/api/agent/codex/events", { id: job.id, events }).catch(() => {})
      });
      await postJson("/api/agent/codex/complete", { id: job.id, result });
      console.log(`  codex ${result.ok ? "completed" : "failed"} (${result.exitCode ?? "no exit code"})`);
    } catch (error) {
      console.error(`[codex ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}`);
      if (job?.id) {
        await postJson("/api/agent/codex/complete", {
          id: job.id,
          result: {
            ok: false,
            error: error.message
          }
        }).catch(() => {});
      }
      await sleep(2500);
    }
  }
}

async function pollNextInsertJob() {
  const response = await httpFetch(`${config.relayUrl}/api/agent/next?wait=25000`, {
    headers: authHeaders(),
    timeoutMs: 35000
  });
  const data = await parseApiResponse(response);
  return data.job || null;
}

async function pollNextCodexJob() {
  const response = await httpFetch(`${config.relayUrl}/api/agent/codex/next?wait=25000`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify({
      workspaces: publicWorkspaces(),
      runtime: publicCodexRuntime()
    }),
    timeoutMs: 35000
  });
  const data = await parseApiResponse(response);
  return data.job || null;
}

async function postJson(path, body) {
  const response = await httpFetch(`${config.relayUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify(body),
    timeoutMs: 60000
  });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function authHeaders() {
  return { "X-Echo-Token": config.token };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatNetworkStatus(status) {
  if (!status.activeProxyUrl) return `direct, timeout=${status.timeoutMs}ms`;
  const fallback = status.proxyFallbackDirect ? ", direct fallback=on" : "";
  return `proxy=${status.activeProxyUrl}${fallback}, timeout=${status.timeoutMs}ms`;
}
