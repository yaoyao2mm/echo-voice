import { execFileSync } from "node:child_process";
import { ProxyAgent } from "undici";
import { config } from "../config.js";

const proxyAgents = new Map();
let systemProxyCache = {
  expiresAt: 0,
  value: ""
};

export async function httpFetch(resource, options = {}) {
  const { timeoutMs = config.network.timeoutMs, ...fetchOptions } = options;
  const url = normalizeUrl(resource);
  const proxyUrl = resolveActiveProxyUrl(url);

  if (proxyUrl) {
    fetchOptions.dispatcher = proxyAgent(proxyUrl);
  }

  if (!fetchOptions.signal && timeoutMs > 0) {
    fetchOptions.signal = AbortSignal.timeout(timeoutMs);
  }

  return fetch(resource, fetchOptions);
}

export function describeHttpNetwork(target = config.relayUrl || config.publicUrl || "https://example.com") {
  const activeProxyUrl = resolveActiveProxyUrl(target);
  return {
    proxyMode: config.network.proxyUrl || "direct",
    activeProxyUrl: redactProxyUrl(activeProxyUrl),
    noProxy: config.network.noProxy,
    timeoutMs: config.network.timeoutMs
  };
}

export function buildProxyEnv(baseEnv = process.env) {
  const next = { ...baseEnv };
  const proxyUrl = resolveActiveProxyUrl("https://api.openai.com");

  if (proxyUrl) {
    next.HTTPS_PROXY ||= proxyUrl;
    next.HTTP_PROXY ||= proxyUrl;
    next.https_proxy ||= proxyUrl;
    next.http_proxy ||= proxyUrl;
  }

  if (config.network.noProxy) {
    next.NO_PROXY ||= config.network.noProxy;
    next.no_proxy ||= config.network.noProxy;
  }

  return next;
}

export function formatFetchError(error) {
  const code = error?.cause?.code || error?.code || "";
  const prefix = code ? `${error.message} (${code})` : error.message;
  if (!isLikelyNetworkError(error)) return prefix;

  const network = safeDescribeHttpNetwork();
  const proxyHint =
    network?.proxyMode === "direct" && process.platform === "darwin" && detectSystemProxy()
      ? "macOS system proxy is available; set ECHO_PROXY_URL=system and restart the desktop agent."
      : "";
  const socksHint = String(config.network.proxyUrl).startsWith("socks")
    ? "ECHO_PROXY_URL supports HTTP/HTTPS proxy URLs; expose an HTTP or mixed proxy port instead of SOCKS-only."
    : "";
  return [prefix, proxyHint || socksHint].filter(Boolean).join(" ");
}

export function resolveActiveProxyUrl(resource) {
  const url = normalizeUrl(resource);
  if (!url || !["http:", "https:"].includes(url.protocol)) return "";
  if (isNoProxyHost(url)) return "";

  const proxyUrl = config.network.proxyUrl;
  if (!proxyUrl) return "";
  if (proxyUrl === "system") return detectSystemProxy();

  validateProxyUrl(proxyUrl);
  return proxyUrl;
}

export function detectSystemProxy() {
  if (process.platform !== "darwin") return "";

  const now = Date.now();
  if (systemProxyCache.expiresAt > now) return systemProxyCache.value;

  const value = readMacSystemProxy();
  systemProxyCache = {
    expiresAt: now + 10_000,
    value
  };
  return value;
}

export function redactProxyUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.username) url.username = "<user>";
    if (url.password) url.password = "<password>";
    return url.toString();
  } catch {
    return "<invalid proxy url>";
  }
}

function proxyAgent(proxyUrl) {
  validateProxyUrl(proxyUrl);
  if (!proxyAgents.has(proxyUrl)) {
    proxyAgents.set(proxyUrl, new ProxyAgent(proxyUrl));
  }
  return proxyAgents.get(proxyUrl);
}

function validateProxyUrl(proxyUrl) {
  const url = new URL(proxyUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("ECHO_PROXY_URL must be an HTTP/HTTPS proxy URL, for example http://127.0.0.1:7897");
  }
}

function normalizeUrl(resource) {
  if (resource instanceof URL) return resource;
  if (typeof resource === "string") return new URL(resource);
  if (resource?.url) return new URL(resource.url);
  return null;
}

function isNoProxyHost(url) {
  const hostname = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const tokens = config.network.noProxy
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return tokens.some((token) => matchesNoProxyToken({ hostname, port }, token));
}

function matchesNoProxyToken({ hostname, port }, token) {
  if (token === "*") return true;
  if (token === "<local>") return !hostname.includes(".");

  if (token.includes("/") && matchesIpv4Cidr(hostname, token)) return true;

  if (token.includes(":") && token === `${hostname}:${port}`) return true;
  if (token.startsWith("*.")) return hostname.endsWith(token.slice(1));
  if (token.startsWith(".")) return hostname === token.slice(1) || hostname.endsWith(token);

  return hostname === token || hostname.endsWith(`.${token}`);
}

function matchesIpv4Cidr(hostname, cidr) {
  const [range, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const hostValue = ipv4ToNumber(hostname);
  const rangeValue = ipv4ToNumber(range);
  if (hostValue === null || rangeValue === null) return false;

  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (hostValue & mask) === (rangeValue & mask);
}

function ipv4ToNumber(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const byte = Number(part);
    if (byte < 0 || byte > 255) return null;
    result = (result << 8) + byte;
  }
  return result >>> 0;
}

function readMacSystemProxy() {
  let output = "";
  try {
    output = execFileSync("scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 1500
    });
  } catch {
    return "";
  }

  const data = parseScutilProxy(output);
  const httpsProxy = proxyFromScutil(data, "HTTPS");
  if (httpsProxy) return httpsProxy;

  return proxyFromScutil(data, "HTTP");
}

function parseScutilProxy(output) {
  const data = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.+?)\s*$/);
    if (match) data[match[1]] = match[2];
  }
  return data;
}

function proxyFromScutil(data, prefix) {
  if (data[`${prefix}Enable`] !== "1") return "";
  const host = data[`${prefix}Proxy`];
  const port = data[`${prefix}Port`];
  if (!host || !port) return "";
  return `http://${host}:${port}`;
}

function isLikelyNetworkError(error) {
  const message = `${error?.name || ""} ${error?.message || ""} ${error?.cause?.code || ""}`;
  return /AbortError|TimeoutError|fetch failed|ECHO_PROXY_URL|proxy|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network/i.test(
    message
  );
}

function safeDescribeHttpNetwork() {
  try {
    return describeHttpNetwork();
  } catch {
    return null;
  }
}
