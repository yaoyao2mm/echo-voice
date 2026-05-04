import assert from "node:assert/strict";
import test from "node:test";
import { installSessions } from "../public/app/sessions.js";

test("conversation timeline keeps streamed follow-up user messages in order when messages snapshot is stale", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-order",
    status: "running",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:04.000Z",
    messages: [
      {
        role: "user",
        text: "第一轮问题",
        externalKey: "user:cmd_1",
        createdAt: "2026-05-04T00:00:00.000Z"
      }
    ],
    events: [
      {
        id: 2,
        at: "2026-05-04T00:00:01.000Z",
        type: "item/completed",
        text: "第一轮回答",
        raw: {
          method: "item/completed",
          params: {
            threadId: "thr_order",
            turnId: "turn_1",
            item: { id: "msg_1", type: "agentMessage", text: "第一轮回答" }
          }
        }
      },
      {
        id: 3,
        at: "2026-05-04T00:00:02.000Z",
        type: "user.message",
        text: "第二轮问题",
        raw: { source: "mobile", commandId: "cmd_2", messageId: "msg_user_2" }
      },
      {
        id: 4,
        at: "2026-05-04T00:00:03.000Z",
        type: "item/completed",
        text: "第二轮回答",
        raw: {
          method: "item/completed",
          params: {
            threadId: "thr_order",
            turnId: "turn_2",
            item: { id: "msg_2", type: "agentMessage", text: "第二轮回答" }
          }
        }
      }
    ]
  });

  assert.deepEqual(
    timeline.filter((entry) => entry.kind === "message").map((entry) => [entry.role, entry.text]),
    [
      ["user", "第一轮问题"],
      ["assistant", "第一轮回答"],
      ["user", "第二轮问题"],
      ["assistant", "第二轮回答"]
    ]
  );
});

test("conversation timeline uses the complete relay draft when retained delta events are truncated", () => {
  const app = createTimelineApp();
  const timeline = app.buildConversationTimeline({
    id: "session-draft",
    status: "running",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:04.000Z",
    finalMessage: "这是完整的前半段，后半段还在继续",
    messages: [
      {
        role: "user",
        text: "写一段长回复",
        externalKey: "user:cmd_1",
        createdAt: "2026-05-04T00:00:00.000Z"
      }
    ],
    events: [
      {
        id: 101,
        at: "2026-05-04T00:00:03.000Z",
        type: "item/agentMessage/delta",
        text: "后半段",
        raw: {
          method: "item/agentMessage/delta",
          params: { threadId: "thr_draft", turnId: "turn_draft", itemId: "msg_draft" }
        }
      },
      {
        id: 102,
        at: "2026-05-04T00:00:04.000Z",
        type: "item/agentMessage/delta",
        text: "还在继续",
        raw: {
          method: "item/agentMessage/delta",
          params: { threadId: "thr_draft", turnId: "turn_draft", itemId: "msg_draft" }
        }
      }
    ]
  });

  assert.equal(timeline.at(-1).role, "assistant");
  assert.equal(timeline.at(-1).text, "这是完整的前半段，后半段还在继续");
});

function createTimelineApp() {
  const app = {
    document: {},
    elements: {},
    navigator: {},
    state: {},
    window: {},
    humanizeCodexError: (value) => value || ""
  };
  installSessions(app);
  return app;
}
