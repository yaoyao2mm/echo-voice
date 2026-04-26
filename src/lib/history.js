import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";

const historyPath = path.join(config.dataDir, "history.json");
let items = [];

export async function loadHistory() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(historyPath, "utf8");
    items = JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Could not load history:", error.message);
    }
    items = [];
  }
}

export function recentHistory(limit = 8) {
  return items.slice(0, limit);
}

export function allHistory(limit = 50) {
  return items.slice(0, limit);
}

export async function addHistory(entry) {
  const item = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...entry
  };

  items.unshift(item);
  items = items.slice(0, 200);
  await fs.writeFile(historyPath, JSON.stringify(items, null, 2));
  return item;
}
