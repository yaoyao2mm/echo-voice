import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";

const managedWorkspaceFile = path.join(config.dataDir, "codex-workspaces.json");

export function managedWorkspaces() {
  return readManagedWorkspaces().map(toPublicWorkspace);
}

export function createManagedWorkspace(input = {}) {
  const label = normalizeLabel(input.label || input.name);
  if (!label) {
    throw new Error("Workspace name is required.");
  }

  const root = workspaceCreationRoot();
  fs.mkdirSync(root, { recursive: true });

  const directoryName = sanitizeDirectoryName(input.directoryName || label);
  const workspacePath = createUniqueDirectory(root, directoryName);
  const existing = [...config.codex.workspaces, ...readManagedWorkspaces()];
  const workspace = {
    id: uniqueWorkspaceId(slug(label), existing),
    label,
    path: workspacePath,
    source: "mobile",
    createdAt: new Date().toISOString()
  };

  writeManagedWorkspaces([...readManagedWorkspaces(), workspace]);
  return toPublicWorkspace(workspace);
}

export function workspaceCreationRoot() {
  const configuredRoot = String(process.env.ECHO_CODEX_WORKSPACE_ROOT || "").trim();
  if (configuredRoot) return path.resolve(expandHome(configuredRoot));

  const firstWorkspacePath = config.codex.workspaces.find((workspace) => workspace.path)?.path;
  if (firstWorkspacePath) return path.dirname(firstWorkspacePath);

  return path.join(os.homedir(), "workspace", "projects");
}

function readManagedWorkspaces() {
  try {
    const content = fs.readFileSync(managedWorkspaceFile, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed?.workspaces)
      ? parsed.workspaces.map(normalizeStoredWorkspace).filter(Boolean)
      : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    console.warn("Could not read managed Codex workspaces:", error.message);
    return [];
  }
}

function writeManagedWorkspaces(workspaces) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const byPath = new Map();
  for (const workspace of workspaces.map(normalizeStoredWorkspace).filter(Boolean)) {
    byPath.set(workspace.path, workspace);
  }
  fs.writeFileSync(
    managedWorkspaceFile,
    `${JSON.stringify({ workspaces: Array.from(byPath.values()) }, null, 2)}\n`,
    "utf8"
  );
}

function normalizeStoredWorkspace(workspace = {}) {
  const workspacePath = String(workspace.path || "").trim();
  const label = normalizeLabel(workspace.label || workspace.id || path.basename(workspacePath));
  if (!workspacePath || !label) return null;
  return {
    id: slug(workspace.id || label),
    label,
    path: path.resolve(expandHome(workspacePath)),
    source: String(workspace.source || "mobile"),
    createdAt: String(workspace.createdAt || "")
  };
}

function toPublicWorkspace(workspace) {
  return {
    id: workspace.id,
    label: workspace.label,
    path: workspace.path
  };
}

function normalizeLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function sanitizeDirectoryName(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!cleaned || cleaned === "." || cleaned === "..") return "project";
  return cleaned;
}

function createUniqueDirectory(root, preferredName) {
  for (let index = 0; index < 200; index += 1) {
    const directoryName = index === 0 ? preferredName : `${preferredName}-${index + 1}`;
    const workspacePath = path.join(root, directoryName);
    try {
      fs.mkdirSync(workspacePath);
      return workspacePath;
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Could not allocate a unique workspace directory.");
}

function uniqueWorkspaceId(preferredId, workspaces) {
  const ids = new Set(workspaces.map((workspace) => workspace.id).filter(Boolean));
  const base = preferredId || "workspace";
  if (!ids.has(base)) return base;
  for (let index = 2; index < 200; index += 1) {
    const candidate = `${base}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "workspace";
}
