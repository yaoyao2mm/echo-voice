import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";

const agentIdPath = path.join(config.dataDir, "desktop-agent-id");

export async function loadDesktopAgentId() {
  await fs.mkdir(config.dataDir, { recursive: true });

  try {
    const existing = (await fs.readFile(agentIdPath, "utf8")).trim();
    if (existing) return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const id = `${os.hostname()}-${crypto.randomBytes(6).toString("hex")}`;
  await fs.writeFile(agentIdPath, `${id}\n`, { mode: 0o600 });
  return id;
}
