import assert from "node:assert/strict";
import test from "node:test";
import { installCodex } from "../public/app/codex.js";

test("composer sends follow-ups to the selected session even when it is high risk", async () => {
  const calls = [];
  const app = createRoutingApp(calls);
  app.state.selectedCodexJobId = "session-high-risk";
  app.state.selectedCodexSession = {
    id: "session-high-risk",
    projectId: "echo",
    status: "active",
    metrics: { risk: "high", eventCount: 220 },
    memory: { summary: "旧会话摘要" }
  };

  await app.sendCodexPrompt({
    projectId: "echo",
    prompt: "现在有个新的 bug，每次我回话都会开启新会话",
    runtime: { model: "gpt-test" },
    attachments: [],
    mode: "execute"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/codex/sessions/session-high-risk/messages");
  assert.equal(calls[0].body.text, "现在有个新的 bug，每次我回话都会开启新会话");
  assert.equal(calls[0].body.projectId, "echo");
  assert.equal(calls[0].body.runtime.model, "gpt-test");
});

test("composer creates a session only when composing a new session", async () => {
  const calls = [];
  const app = createRoutingApp(calls);
  app.state.composingNewSession = true;
  app.state.selectedCodexJobId = "session-existing";
  app.state.selectedCodexSession = {
    id: "session-existing",
    projectId: "echo",
    status: "active"
  };

  await app.sendCodexPrompt({
    projectId: "echo",
    prompt: "开启一个新话题",
    runtime: {},
    attachments: [],
    mode: "plan"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/codex/sessions");
  assert.deepEqual(calls[0].body, {
    projectId: "echo",
    prompt: "开启一个新话题",
    runtime: {},
    attachments: [],
    mode: "plan"
  });
});

function createRoutingApp(calls) {
  const app = {
    constants: {},
    elements: {},
    state: {
      selectedCodexJobId: "",
      selectedCodexSession: null,
      composingNewSession: false
    },
    currentProjectId: () => "echo",
    sessionBelongsToCurrentProject: (session) => Boolean(session?.id && session.projectId === "echo"),
    apiPost: async (path, body) => {
      calls.push({ path, body });
      return {
        session: {
          id: path.endsWith("/messages") ? "session-high-risk" : "session-new",
          projectId: body.projectId,
          status: "queued"
        }
      };
    }
  };
  installCodex(app);
  return app;
}
