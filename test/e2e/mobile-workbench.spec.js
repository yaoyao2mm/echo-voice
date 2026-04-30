import { expect, test } from "@playwright/test";

const pairingToken = "e2e-pairing-token-123456";
const credentials = {
  username: "mobile_e2e_user_20260430",
  password: "MobileE2EPass20260430"
};

async function touchMockAgent(request) {
  const response = await request.post("/api/agent/codex/sessions/next?wait=1", {
    headers: {
      "X-Echo-Token": pairingToken
    },
    data: {
      wait: 1,
      agentId: "mobile-e2e-agent",
      workspaces: [
        {
          id: "echo",
          label: "echo",
          path: process.cwd()
        }
      ],
      runtime: {
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium"
      }
    }
  });
  expect(response.ok()).toBeTruthy();
}

async function loginToWorkbench(page) {
  await page.goto(`/?token=${pairingToken}`);

  await expect(page.locator("#loginPanel")).toBeVisible();
  await page.locator("#loginUsername").fill(credentials.username);
  await page.locator("#loginPassword").fill(credentials.password);
  await page.locator("#loginButton").click();

  await expect(page.locator("#codexView")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/mobile-ui/);
  await expect(page.locator("#toggleSessionsButton")).toBeVisible();
  await expect(page.locator("#mobileStatusIndicator")).toBeVisible();
  await expect(page.locator("#codexStatusText")).toContainText("本机 Codex 在线");
  await expect(page.locator("#projectPickerLabel")).toContainText("echo");
}

async function authHeadersForSessionRequests(request) {
  const response = await request.post("/api/auth/login", {
    data: credentials
  });
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  return {
    Authorization: `Bearer ${data.sessionToken}`,
    "X-Echo-Token": pairingToken
  };
}

test("mobile login, pairing, sidebar, and session creation", async ({ page, request }) => {
  await touchMockAgent(request);
  const keepAlive = setInterval(() => {
    touchMockAgent(request).catch(() => {});
  }, 10000);

  try {
    await loginToWorkbench(page);

    await page.locator("#toggleSessionsButton").click();
    await expect(page.locator("#codexView")).toHaveClass(/sessions-open/);
    await expect(page.locator("#sessionBackdrop")).toBeVisible();
    await page.locator("#sessionBackdrop").click();
    await expect(page.locator("#codexView")).not.toHaveClass(/sessions-open/);

    await expect(page.locator("#sendCodexButton")).toBeDisabled();
    await page.locator("#codexPrompt").fill("E2E mobile workbench smoke test");
    await expect(page.locator("#sendCodexButton")).toBeEnabled();
    await page.locator("#sendCodexButton").click();

    await expect(page.locator(".toast")).toContainText("已发送");
    await expect(page.locator(".conversation-item")).toHaveCount(1);
    await expect(page.locator("#activeSessionMeta")).toContainText(/排队中|启动中|运行中/);
    await expect(page.locator("#codexRunSummary")).toContainText("E2E mobile workbench smoke test");
    await expect(page.locator("#sendCodexButton")).toBeDisabled();
  } finally {
    clearInterval(keepAlive);
  }
});

test("mobile composer sends text and screenshot in the same session message", async ({ page, request }) => {
  await page.addInitScript(() => {
    const NativeFileReader = window.FileReader;
    class DelayedFileReader extends NativeFileReader {
      readAsDataURL(blob) {
        window.setTimeout(() => super.readAsDataURL(blob), 250);
      }
    }
    window.FileReader = DelayedFileReader;
  });

  await touchMockAgent(request);
  const keepAlive = setInterval(() => {
    touchMockAgent(request).catch(() => {});
  }, 10000);

  try {
    const headers = await authHeadersForSessionRequests(request);
    const prompt = `请结合这张图修复移动端布局 ${Date.now()}`;

    await loginToWorkbench(page);
    await page.locator("#codexPrompt").fill(prompt);
    await page.locator("#composerAttachmentInput").setInputFiles({
      name: "mobile-layout.png",
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+KDvY8QAAAABJRU5ErkJggg==", "base64")
    });

    await expect(page.locator("#composerStatusText")).toContainText("正在处理 1 张图片");
    await expect(page.locator("#sendCodexButton")).toBeDisabled();
    await expect(page.locator("#composerAttachmentTray")).toContainText("mobile-layout.png");
    await expect(page.locator("#sendCodexButton")).toBeEnabled();

    await page.locator("#sendCodexButton").click();
    await expect(page.locator(".toast")).toContainText("已发送 1 个附件");

    const sessionsResponse = await request.get("/api/codex/sessions", { headers });
    expect(sessionsResponse.ok()).toBeTruthy();
    const sessionsData = await sessionsResponse.json();
    const createdSession = sessionsData.items[0];
    expect(createdSession).toBeTruthy();

    const sessionResponse = await request.get(`/api/codex/sessions/${createdSession.id}`, { headers });
    expect(sessionResponse.ok()).toBeTruthy();
    const sessionData = await sessionResponse.json();
    const userEvent = sessionData.session.events.find((event) => event.type === "user.message" && event.text === prompt);
    expect(userEvent).toBeTruthy();
    expect(userEvent.raw.attachments).toHaveLength(1);
    expect(userEvent.raw.attachments[0].name).toBe("mobile-layout.png");
    expect(userEvent.raw.attachments[0].url.startsWith("data:image/png;base64,")).toBeTruthy();
  } finally {
    clearInterval(keepAlive);
  }
});
