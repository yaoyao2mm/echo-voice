import fs from "node:fs/promises";
import path from "node:path";

const defaultMaxEntries = 240;
const absoluteMaxEntries = 500;
const defaultMaxBytes = 160 * 1024;
const absoluteMaxBytes = 320 * 1024;

const blockedBasenames = new Set([
  ".env",
  ".envrc",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa"
]);

const blockedExtensions = new Set([".key", ".pem", ".p12", ".pfx"]);

export async function listWorkspaceFiles({ projectId, relativePath = "", workspaces = [], maxEntries } = {}) {
  const workspace = workspaceForProject(projectId, workspaces);
  const target = await resolveWorkspaceTarget(workspace, relativePath);
  const stats = await fs.stat(target.absolutePath);
  if (!stats.isDirectory()) {
    throw publicError("Only directories can be listed.", "NOT_DIRECTORY");
  }

  const limit = clampNumber(maxEntries, defaultMaxEntries, 1, absoluteMaxEntries);
  const dirents = await fs.readdir(target.absolutePath, { withFileTypes: true });
  const sorted = dirents.sort(compareDirents);
  const visible = sorted.slice(0, limit);
  const items = await Promise.all(visible.map((dirent) => describeDirectoryEntry(dirent, target)));

  return {
    ok: true,
    tree: {
      projectId: workspace.id,
      workspace: publicWorkspace(workspace),
      path: target.relativePath,
      parentPath: parentBrowserPath(target.relativePath),
      entries: items,
      truncated: sorted.length > visible.length,
      totalEntries: sorted.length,
      maxEntries: limit
    }
  };
}

export async function readWorkspaceFile({ projectId, relativePath = "", workspaces = [], maxBytes } = {}) {
  const workspace = workspaceForProject(projectId, workspaces);
  const normalizedPath = normalizeBrowserPath(relativePath);
  if (!normalizedPath) throw publicError("Choose a file to preview.", "FILE_REQUIRED");
  if (isSensitiveBrowserPath(normalizedPath)) {
    throw publicError("Sensitive file previews are blocked.", "SENSITIVE_FILE");
  }

  const target = await resolveWorkspaceTarget(workspace, normalizedPath);
  const stats = await fs.stat(target.absolutePath);
  if (!stats.isFile()) {
    throw publicError("Only text files can be previewed.", "NOT_FILE");
  }

  const limit = clampNumber(maxBytes, defaultMaxBytes, 1024, absoluteMaxBytes);
  const handle = await fs.open(target.absolutePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(limit + 1, Math.max(limit, 1)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const contentBuffer = buffer.subarray(0, Math.min(bytesRead, limit));
    if (looksBinary(contentBuffer)) {
      throw publicError("Only text files can be previewed.", "BINARY_FILE");
    }

    return {
      ok: true,
      file: {
        projectId: workspace.id,
        workspace: publicWorkspace(workspace),
        path: target.relativePath,
        name: path.posix.basename(target.relativePath),
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        content: contentBuffer.toString("utf8"),
        encoding: "utf8",
        truncated: bytesRead > limit || stats.size > limit,
        bytesRead: contentBuffer.length,
        maxBytes: limit
      }
    };
  } finally {
    await handle.close();
  }
}

export function normalizeBrowserPath(value = "") {
  const raw = String(value || "").replaceAll("\\", "/").trim();
  if (!raw || raw === "." || raw === "/") return "";
  if (raw.includes("\0")) throw publicError("File path is invalid.", "INVALID_PATH");
  if (raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw) || raw.startsWith("~/") || raw === "~") {
    throw publicError("File browser paths must be relative to the selected workspace.", "ABSOLUTE_PATH");
  }

  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      throw publicError("File browser paths must stay inside the selected workspace.", "PATH_ESCAPE");
    }
    parts.push(part);
  }
  return parts.join("/");
}

function workspaceForProject(projectId, workspaces = []) {
  const normalizedProjectId = String(projectId || "").trim();
  const workspace = (workspaces || []).find((item) => String(item?.id || "").trim() === normalizedProjectId);
  if (!normalizedProjectId) throw publicError("Codex project is required.", "PROJECT_REQUIRED");
  if (!workspace?.path) throw publicError("Workspace is not advertised by this desktop agent.", "WORKSPACE_NOT_FOUND");
  return {
    id: String(workspace.id || "").trim(),
    label: String(workspace.label || workspace.id || "").trim(),
    path: String(workspace.path || "").trim()
  };
}

async function resolveWorkspaceTarget(workspace, relativePath) {
  const normalizedPath = normalizeBrowserPath(relativePath);
  const workspacePath = path.resolve(workspace.path);
  const targetPath = normalizedPath
    ? path.resolve(workspacePath, ...normalizedPath.split("/"))
    : workspacePath;

  if (!isPathInsideOrSame(targetPath, workspacePath)) {
    throw publicError("File browser paths must stay inside the selected workspace.", "PATH_ESCAPE");
  }

  let workspaceRealPath;
  let targetRealPath;
  try {
    workspaceRealPath = await fs.realpath(workspacePath);
    targetRealPath = await fs.realpath(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw publicError("File or directory was not found.", "NOT_FOUND");
    throw error;
  }

  if (!isPathInsideOrSame(targetRealPath, workspaceRealPath)) {
    throw publicError("File browser paths must stay inside the selected workspace.", "PATH_ESCAPE");
  }

  return {
    workspace,
    workspacePath,
    workspaceRealPath,
    absolutePath: targetPath,
    realPath: targetRealPath,
    relativePath: normalizedPath
  };
}

async function describeDirectoryEntry(dirent, target) {
  const name = dirent.name;
  const childRelativePath = joinBrowserPath(target.relativePath, name);
  const childPath = path.join(target.absolutePath, name);
  let lstat = null;
  let stat = null;
  let type = direntType(dirent);
  let outsideWorkspace = false;

  try {
    lstat = await fs.lstat(childPath);
    if (lstat.isSymbolicLink()) {
      const realPath = await fs.realpath(childPath);
      outsideWorkspace = !isPathInsideOrSame(realPath, target.workspaceRealPath);
      if (!outsideWorkspace) {
        stat = await fs.stat(childPath);
        type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
      } else {
        type = "symlink";
      }
    } else {
      stat = lstat;
    }
  } catch {
    type = "other";
  }

  const activeStat = stat || lstat;
  return {
    name,
    path: childRelativePath,
    type,
    size: activeStat?.isFile?.() ? activeStat.size : 0,
    mtime: activeStat?.mtime ? activeStat.mtime.toISOString() : "",
    isSymlink: Boolean(lstat?.isSymbolicLink?.()),
    outsideWorkspace,
    previewable: type === "file" && !outsideWorkspace && !isSensitiveBrowserPath(childRelativePath)
  };
}

function direntType(dirent) {
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  if (dirent.isSymbolicLink()) return "symlink";
  return "other";
}

function compareDirents(left, right) {
  const rankDelta = direntRank(left) - direntRank(right);
  if (rankDelta !== 0) return rankDelta;
  return left.name.localeCompare(right.name, "en", { sensitivity: "base", numeric: true });
}

function direntRank(dirent) {
  if (dirent.isDirectory()) return 0;
  if (dirent.isFile()) return 1;
  if (dirent.isSymbolicLink()) return 2;
  return 3;
}

function isSensitiveBrowserPath(browserPath) {
  const parts = normalizeBrowserPath(browserPath).split("/").filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (lowerParts.some((part) => part === ".ssh" || part === ".gnupg")) return true;
  const basename = lowerParts.at(-1) || "";
  if (!basename) return false;
  if (blockedBasenames.has(basename)) return true;
  if (basename.startsWith(".env.")) return true;
  if (basename.endsWith(".env")) return true;
  return blockedExtensions.has(path.posix.extname(basename));
}

function looksBinary(buffer) {
  if (!buffer.length) return false;
  if (buffer.includes(0)) return true;
  const sampleLength = Math.min(buffer.length, 4096);
  let suspicious = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index];
    const allowedControl = byte === 7 || byte === 8 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 27;
    if (byte < 32 && !allowedControl) suspicious += 1;
  }
  return suspicious / sampleLength > 0.08;
}

function joinBrowserPath(parent, child) {
  const safeChild = String(child || "").replaceAll("/", "");
  return parent ? `${parent}/${safeChild}` : safeChild;
}

function parentBrowserPath(browserPath) {
  const normalizedPath = normalizeBrowserPath(browserPath);
  if (!normalizedPath) return "";
  const parts = normalizedPath.split("/");
  parts.pop();
  return parts.join("/");
}

function publicWorkspace(workspace) {
  return {
    id: workspace.id,
    label: workspace.label || workspace.id,
    path: workspace.path
  };
}

function isPathInsideOrSame(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.floor(number), max));
}

function publicError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
