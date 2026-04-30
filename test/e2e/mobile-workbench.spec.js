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

test("mobile login, pairing, sidebar, and session creation", async ({ page, request }) => {
  await touchMockAgent(request);
  const keepAlive = setInterval(() => {
    touchMockAgent(request).catch(() => {});
  }, 10000);

  try {
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
