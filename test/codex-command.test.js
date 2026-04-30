import test from "node:test";
import assert from "node:assert/strict";
import { bundledCodexCommandPath, resolveCodexCommand, resolveDesktopCodexCommand } from "../src/lib/codexCommand.js";

test("resolveCodexCommand prefers the bundled macOS Codex app when the command is generic", () => {
  const existsSync = (value) => value === "/Applications/Codex.app/Contents/Resources/codex";
  assert.equal(
    bundledCodexCommandPath("darwin", existsSync),
    "/Applications/Codex.app/Contents/Resources/codex"
  );
  assert.equal(
    resolveCodexCommand("codex", { platform: "darwin", existsSync }),
    "/Applications/Codex.app/Contents/Resources/codex"
  );
});

test("resolveCodexCommand keeps explicit commands unchanged", () => {
  const existsSync = () => true;
  assert.equal(resolveCodexCommand("/opt/homebrew/bin/codex", { platform: "darwin", existsSync }), "/opt/homebrew/bin/codex");
  assert.equal(resolveCodexCommand("custom-codex", { platform: "darwin", existsSync }), "custom-codex");
});

test("resolveCodexCommand falls back to codex when the bundled app is unavailable", () => {
  assert.equal(resolveCodexCommand("codex", { platform: "darwin", existsSync: () => false }), "codex");
  assert.equal(resolveCodexCommand("codex", { platform: "linux", existsSync: () => true }), "codex");
});

test("resolveDesktopCodexCommand on macOS ignores a legacy brew command and uses Codex.app", () => {
  const existsSync = (value) => value === "/Applications/Codex.app/Contents/Resources/codex";
  const result = resolveDesktopCodexCommand({
    platform: "darwin",
    existsSync,
    configuredCommand: "/opt/homebrew/bin/codex"
  });
  assert.equal(result.ok, true);
  assert.equal(result.command, "/Applications/Codex.app/Contents/Resources/codex");
  assert.equal(result.source, "codex-app");
  assert.match(result.detail, /Ignoring legacy ECHO_CODEX_COMMAND/);
});

test("resolveDesktopCodexCommand on macOS requires the official Codex app", () => {
  const result = resolveDesktopCodexCommand({
    platform: "darwin",
    existsSync: () => false,
    configuredCommand: "/opt/homebrew/bin/codex"
  });
  assert.equal(result.ok, false);
  assert.equal(result.command, "");
  assert.equal(result.source, "missing-codex-app");
  assert.match(result.detail, /Codex\.app is required on macOS/);
});
