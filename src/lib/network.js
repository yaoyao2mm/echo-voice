import os from "node:os";

export function getLanUrls(port, token, protocol = "http") {
  const urls = [];
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      urls.push(`${protocol}://${entry.address}:${port}/?token=${encodeURIComponent(token)}`);
    }
  }

  urls.push(`${protocol}://localhost:${port}/?token=${encodeURIComponent(token)}`);
  return urls;
}
