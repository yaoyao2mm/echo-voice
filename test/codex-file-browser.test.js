import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listWorkspaceFiles, normalizeBrowserPath, readWorkspaceFile } from "../src/lib/codexFileBrowser.js";

test("file browser lists workspace directories and previews text files", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "echo-files-workspace-"));
  fs.mkdirSync(path.join(workspacePath, "src"));
  fs.writeFileSync(path.join(workspacePath, "src", "app.js"), "console.log('echo');\n", "utf8");

  const workspaces = [{ id: "demo", label: "Demo", path: workspacePath }];
  const listed = await listWorkspaceFiles({ projectId: "demo", relativePath: "", workspaces });
  assert.equal(listed.ok, true);
  assert.equal(listed.tree.entries.some((entry) => entry.name === "src" && entry.type === "directory"), true);

  const nested = await listWorkspaceFiles({ projectId: "demo", relativePath: "src", workspaces });
  assert.equal(nested.tree.path, "src");
  assert.equal(nested.tree.parentPath, "");
  assert.equal(nested.tree.entries[0].name, "app.js");
  assert.equal(nested.tree.entries[0].previewable, true);

  const preview = await readWorkspaceFile({ projectId: "demo", relativePath: "src/app.js", workspaces });
  assert.equal(preview.ok, true);
  assert.equal(preview.file.content, "console.log('echo');\n");
  assert.equal(preview.file.truncated, false);
});

test("file browser rejects path traversal and symlink escapes", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "echo-files-workspace-"));
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "echo-files-outside-"));
  fs.writeFileSync(path.join(outsidePath, "secret.txt"), "secret\n", "utf8");
  fs.symlinkSync(outsidePath, path.join(workspacePath, "outside-link"));

  assert.throws(() => normalizeBrowserPath("../secret.txt"), /stay inside/);
  await assert.rejects(
    () =>
      readWorkspaceFile({
        projectId: "demo",
        relativePath: "outside-link/secret.txt",
        workspaces: [{ id: "demo", path: workspacePath }]
      }),
    /stay inside/
  );
});

test("file browser blocks sensitive previews and binary files", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "echo-files-workspace-"));
  fs.writeFileSync(path.join(workspacePath, ".env"), "TOKEN=secret\n", "utf8");
  fs.writeFileSync(path.join(workspacePath, "image.bin"), Buffer.from([0, 1, 2, 3, 4]));
  const workspaces = [{ id: "demo", path: workspacePath }];

  await assert.rejects(() => readWorkspaceFile({ projectId: "demo", relativePath: ".env", workspaces }), /Sensitive/);
  await assert.rejects(() => readWorkspaceFile({ projectId: "demo", relativePath: "image.bin", workspaces }), /text files/);
});
