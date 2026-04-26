import { config } from "./config.js";
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
console.log("Keep the target app focused before sending text from the phone.\n");

while (true) {
  let job = null;
  try {
    job = await pollNextJob();
    if (!job) continue;

    console.log(`[${new Date().toLocaleTimeString()}] inserting ${job.text.length} chars`);
    const result = await insertText(job.text);
    await postJson("/api/agent/ack", { id: job.id, result });
    console.log(`  ${result.message}`);
  } catch (error) {
    console.error(`[${new Date().toLocaleTimeString()}] ${error.message}`);
    if (job?.id) {
      await postJson("/api/agent/fail", { id: job.id, error: error.message }).catch(() => {});
    }
    await sleep(2500);
  }
}

async function pollNextJob() {
  const response = await fetch(`${config.relayUrl}/api/agent/next?wait=25000`, {
    headers: authHeaders()
  });
  const data = await parseApiResponse(response);
  return data.job || null;
}

async function postJson(path, body) {
  const response = await fetch(`${config.relayUrl}${path}`, {
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

function authHeaders() {
  return { "X-Echo-Token": config.token };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
