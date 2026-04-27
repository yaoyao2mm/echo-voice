#!/usr/bin/env node
import dns from "node:dns/promises";
import { config } from "../src/config.js";
import { describeHttpNetwork, detectSystemProxy, formatFetchError, httpFetch } from "../src/lib/http.js";

const targetBase = config.relayUrl || config.publicUrl;

if (!targetBase) {
  fail("Missing ECHO_RELAY_URL or ECHO_PUBLIC_URL.");
}

if (!process.env.ECHO_TOKEN) {
  fail("Missing ECHO_TOKEN. The doctor uses the same token as the desktop agent.");
}

const statusUrl = new URL("/api/status", targetBase);
const network = describeHttpNetwork(statusUrl);

console.log("Echo Voice network doctor");
console.log(`Target: ${statusUrl.origin}`);
console.log(`Proxy:  ${network.activeProxyUrl || network.proxyMode}`);
console.log(`NO_PROXY: ${network.noProxy}`);
console.log(`Timeout: ${network.timeoutMs}ms`);

if (process.platform === "darwin") {
  console.log(`macOS system proxy: ${detectSystemProxy() || "off"}`);
}

try {
  const addresses = await dns.lookup(statusUrl.hostname, { all: true });
  console.log(`DNS: ${addresses.map((item) => item.address).join(", ") || "no result"}`);
} catch (error) {
  console.log(`DNS: failed (${error.message})`);
}

try {
  const startedAt = Date.now();
  const response = await httpFetch(statusUrl, {
    headers: {
      "X-Echo-Token": config.token
    },
    timeoutMs: 15000
  });
  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    fail(`Relay replied HTTP ${response.status}: ${json.error || response.statusText}`);
  }

  console.log(`Relay: ok in ${Date.now() - startedAt}ms`);
  console.log(`Mode: ${json.mode || "unknown"}`);
  if (json.refine?.provider) {
    console.log(`Refine: ${json.refine.provider} / ${json.refine.model || "unknown model"}`);
  }
} catch (error) {
  fail(formatFetchError(error));
}

function fail(message) {
  console.error(`Network doctor failed: ${message}`);
  process.exit(1);
}
