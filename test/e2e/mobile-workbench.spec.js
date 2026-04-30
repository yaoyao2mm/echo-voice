import { expect, test } from "@playwright/test";

const pairingToken = "e2e-pairing-token-123456";
const credentials = {
  username: "mobile_e2e_user_20260430",
  password: "MobileE2EPass20260430"
};

function defaultMockWorkspaces() {
  return [
    {
      id: "echo",
      label: "echo",
      path: process.cwd()
    }
  ];
}

function defaultMockRuntime(runtimeOverrides = {}) {
  return {
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    ...runtimeOverrides
  };
}

async function touchMockAgent(request, runtimeOverrides = {}, workspaces = defaultMockWorkspaces()) {
  const response = await request.post("/api/agent/codex/sessions/next?wait=1", {
    headers: {
      "X-Echo-Token": pairingToken
    },
    data: {
      wait: 1,
      agentId: "mobile-e2e-agent",
      workspaces,
      runtime: defaultMockRuntime(runtimeOverrides)
    }
  });
  expect(response.ok()).toBeTruthy();
}

async function leaseNextCodexCommand(request) {
  const response = await request.post("/api/agent/codex/sessions/next?wait=1000", {
    headers: {
      "X-Echo-Token": pairingToken
    },
    data: {
      wait: 1000,
      agentId: "mobile-e2e-agent",
      workspaces: defaultMockWorkspaces(),
      runtime: defaultMockRuntime()
    }
  });
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  expect(data.command).toBeTruthy();
  return data.command;
}

async function leaseNextWorkspaceCommand(request) {
  const response = await request.post("/api/agent/codex/workspaces/next?wait=1000", {
    headers: {
      "X-Echo-Token": pairingToken
    },
    data: {
      wait: 1000,
      agentId: "mobile-e2e-agent",
      workspaces: defaultMockWorkspaces(),
      runtime: defaultMockRuntime()
    }
  });
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  expect(data.command).toBeTruthy();
  return data.command;
}

async function activateCodexSession(request, sessionId) {
  const command = await leaseNextCodexCommand(request);
  expect(command.sessionId).toBe(sessionId);
  const appThreadId = `thr_${sessionId}`;
  const eventsResponse = await request.post("/api/agent/codex/sessions/events", {
    headers: {
      "X-Echo-Token": pairingToken
    },
    data: {
      id: sessionId,
      agentId: "mobile-e2e-agent",
      events: [{ type: "thread.started", text: "started", appThreadId, sessionStatus: "active" }]
    }
  });
  expect(eventsResponse.ok()).toBeTruthy();
  const completeResponse = await request.post("/api/agent/codex/sessions/commands/complete", {
    headers: {
      "X-Echo-Token": pairingToken
    },
    data: {
      id: command.id,
      agentId: "mobile-e2e-agent",
      result: { ok: true, appThreadId, sessionStatus: "active" }
    }
  });
  expect(completeResponse.ok()).toBeTruthy();
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
  await expect(page.locator("#contextUsageIndicator")).toBeVisible();
  await expect(page.locator("#contextUsageIndicator")).toHaveAttribute("role", "meter");
  await expect(page.locator("#quickDeployButton")).toBeVisible();
  await expect(page.locator("#composerAttachmentButton")).toHaveCSS("width", "24px");
  await expect(page.locator("#quickDeployButton")).toHaveCSS("width", "34px");
  await expect(page.locator("#contextUsageIndicator")).toHaveCSS("width", "16px");
  const topbarIconLayout = await page.evaluate(() => {
    const titleRow = document.querySelector(".topbar-title-row");
    const status = document.querySelector("#mobileStatusIndicator");
    const context = document.querySelector("#contextUsageIndicator")?.getBoundingClientRect();
    const deploy = document.querySelector("#quickDeployButton")?.getBoundingClientRect();
    const composer = document.querySelector(".composer-statusbar")?.getBoundingClientRect();
    return {
      statusBesideTitle: Boolean(titleRow && status && titleRow.contains(status)),
      deployInTopbar: Boolean(context && deploy && composer && deploy.top < composer.top),
      deployRightOfContext: Boolean(context && deploy && deploy.left > context.right)
    };
  });
  expect(topbarIconLayout.statusBesideTitle).toBeTruthy();
  expect(topbarIconLayout.deployInTopbar).toBeTruthy();
  expect(topbarIconLayout.deployRightOfContext).toBeTruthy();
  await expect(page.locator(".composer-status-scope")).toHaveCount(0);
  await expect(page.locator("#codexStatusText")).toContainText("本机 Codex 在线");
  await expect(page.locator("#projectPickerLabel")).toContainText("echo");
}

async function reopenWorkbench(page) {
  await page.goto("/");
  if (await page.locator("#loginPanel").isVisible()) {
    await page.locator("#loginUsername").fill(credentials.username);
    await page.locator("#loginPassword").fill(credentials.password);
    await page.locator("#loginButton").click();
  }
  await expect(page.locator("#codexView")).toBeVisible();
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
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__echoCopiedText = String(text);
        }
      }
    });
  });

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

    await expect(page.locator(".conversation-item")).toHaveCount(1);
    await expect(page.locator("#activeSessionMeta")).toContainText(/排队中|启动中|运行中/);
    await expect(page.locator("#codexRunSummary")).toContainText("E2E mobile workbench smoke test");
    await expect(page.locator(".toast", { hasText: "已发送" })).toHaveCount(0);
    await expect(page.locator("#sendCodexButton")).toBeDisabled();
    await expect(page.locator("#contextUsageIndicator")).toHaveAttribute("aria-label", /上下文使用约/);
    await expect
      .poll(() => page.locator("#contextUsageIndicator").evaluate((node) => Number(node.getAttribute("aria-valuenow"))))
      .toBeGreaterThanOrEqual(0);

    const message = page.locator(".thread-message-user", { hasText: "E2E mobile workbench smoke test" }).first();
    const copyAction = message.getByRole("button", { name: "复制消息" });
    const editAction = message.getByRole("button", { name: "重新编辑消息" });
    await expect(copyAction).toBeVisible();
    await expect(editAction).toBeVisible();
    await expect(copyAction).toHaveText("");
    await expect(editAction).toHaveText("");
    await expect(message.locator(".thread-message-actions")).toHaveCSS("gap", "5px");
    await copyAction.click();
    await expect.poll(() => page.evaluate(() => window.__echoCopiedText)).toBe("E2E mobile workbench smoke test");
    await editAction.click();
    await expect(page.locator("#codexPrompt")).toHaveValue("E2E mobile workbench smoke test");
    await expect(page.locator("#sendCodexButton")).toBeEnabled();
  } finally {
    clearInterval(keepAlive);
  }
});

test("mobile composer defaults to GPT-5.5 and remembers the last chosen model", async ({ page, request }) => {
  await touchMockAgent(request);
  const keepAlive = setInterval(() => {
    touchMockAgent(request).catch(() => {});
  }, 10000);

  try {
    await loginToWorkbench(page);
    await expect(page.locator("#codexModel")).toHaveValue("gpt-5.5");

    await page.locator("#codexModel").selectOption("gpt-5.4");
    await expect(page.locator("#codexModel")).toHaveValue("gpt-5.4");

    await reopenWorkbench(page);
    await page.locator("#toggleSessionsButton").click();
    await page.locator("#newCodexSessionButton").click();
    await expect(page.locator("#codexModel")).toHaveValue("gpt-5.4");
  } finally {
    clearInterval(keepAlive);
  }
});

test("mobile composer disables models unsupported by the desktop Codex", async ({ page, request }) => {
  await touchMockAgent(request, { unsupportedModels: ["gpt-5.5"] });
  const keepAlive = setInterval(() => {
    touchMockAgent(request, { unsupportedModels: ["gpt-5.5"] }).catch(() => {});
  }, 10000);

  try {
    await loginToWorkbench(page);
    await expect(page.locator("#codexModel")).toHaveValue("");
    await expect(page.locator('#codexModel option[value="gpt-5.5"]')).toHaveAttribute("disabled", "");
  } finally {
    clearInterval(keepAlive);
  }
});

test("mobile topbar project switcher creates and switches to a new project", async ({ page, request }) => {
  await touchMockAgent(request);
  const keepAlive = setInterval(() => {
    touchMockAgent(request).catch(() => {});
  }, 10000);

  try {
    await loginToWorkbench(page);
    await page.locator("#projectSwitcherButton").click();
    await expect(page.locator("#projectSwitcherPanel")).toBeVisible();
    await expect(page.locator("#newProjectButton")).toBeEnabled();
    await page.locator("#newProjectButton").click();
    await expect(page.locator("#projectCreateForm")).toBeVisible();

    const projectLabel = `mobile project ${Date.now()}`;
    await page.locator("#projectCreateName").fill(projectLabel);
    await page.locator("#projectCreateSubmit").click();

    const command = await leaseNextWorkspaceCommand(request);
    expect(command.payload.name).toBe(projectLabel);
    const workspace = {
      id: "mobile-project-e2e",
      label: projectLabel,
      path: `${process.cwd()}/mobile-project-e2e`
    };
    const completeResponse = await request.post("/api/agent/codex/workspaces/commands/complete", {
      headers: {
        "X-Echo-Token": pairingToken
      },
      data: {
        id: command.id,
        agentId: "mobile-e2e-agent",
        result: { ok: true, workspace },
        workspaces: [...defaultMockWorkspaces(), workspace],
        runtime: defaultMockRuntime()
      }
    });
    expect(completeResponse.ok()).toBeTruthy();

    await expect(page.locator("#projectCreateForm")).toBeHidden();
    await expect(page.locator("#projectPickerLabel")).toContainText("mobile-project-e2e");
    await expect(page.locator("#projectSwitcherButton")).toContainText("mobile-project-e2e");
    await expect(page.locator("#codexProject")).toHaveValue(workspace.id);
    await expect(page.locator(".project-option.active")).toContainText("mobile-project-e2e");
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

    const sessionsResponse = await request.get("/api/codex/sessions", { headers });
    expect(sessionsResponse.ok()).toBeTruthy();
    const sessionsData = await sessionsResponse.json();
    const createdSession = sessionsData.items[0];
    expect(createdSession).toBeTruthy();

    const sessionResponse = await request.get(`/api/codex/sessions/${createdSession.id}`, { headers });
    expect(sessionResponse.ok()).toBeTruthy();
    const sessionData = await sessionResponse.json();
    const userMessage = sessionData.session.messages.find((message) => message.role === "user" && message.text === prompt);
    expect(userMessage).toBeTruthy();
    expect(userMessage.attachments).toHaveLength(1);
    await expect(page.locator(".toast", { hasText: "已发送 1 个附件" })).toHaveCount(0);
    expect(userMessage.attachments[0].name).toBe("mobile-layout.png");
    expect(userMessage.attachments[0].downloadPath).toContain("/api/codex/attachments/");
    const attachmentResponse = await request.get(userMessage.attachments[0].downloadPath, { headers });
    expect(attachmentResponse.ok()).toBeTruthy();
    expect((await attachmentResponse.body()).length).toBeGreaterThan(0);
  } finally {
    clearInterval(keepAlive);
  }
});

test("mobile composer stays pinned while the conversation surface scrolls", async ({ page, request }) => {
  await touchMockAgent(request);
  const keepAlive = setInterval(() => {
    touchMockAgent(request).catch(() => {});
  }, 10000);

  try {
    await loginToWorkbench(page);

    const initialComposer = await page.locator(".composer").evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        position: window.getComputedStyle(node).position,
        top: rect.top,
        bottomGap: window.innerHeight - rect.bottom
      };
    });

    expect(initialComposer.position).toBe("relative");
    expect(initialComposer.bottomGap).toBeLessThanOrEqual(1);
    await expect(page.locator("#codexJobDetail")).toHaveCSS("padding-bottom", "8px");
    await expect
      .poll(() =>
        page.locator(".composer-toolbar").evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return Math.round(window.innerWidth - rect.right);
        })
      )
      .toBeLessThanOrEqual(1);

    await page.evaluate(() => {
      const surface = document.querySelector("#codexJobDetail");
      const thread = document.querySelector(".conversation-thread");
      if (!surface || !thread) return;
      const filler = document.createElement("div");
      filler.setAttribute("data-test-filler", "true");
      filler.style.height = "1600px";
      thread.append(filler);
      surface.scrollTop = surface.scrollHeight;
      surface.dispatchEvent(new Event("scroll"));
    });

    await expect
      .poll(() => page.locator("#codexJobDetail").evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    await expect(page.locator("body")).not.toHaveClass(/topbar-collapsed/);

    const documentScrollTop = await page.evaluate(() => document.scrollingElement?.scrollTop || 0);
    expect(documentScrollTop).toBe(0);

    const scrolledComposer = await page.locator(".composer").evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        bottomGap: window.innerHeight - rect.bottom,
        topbarCollapsed: document.body.classList.contains("topbar-collapsed")
      };
    });

    if (!scrolledComposer.topbarCollapsed) {
      expect(Math.abs(scrolledComposer.top - initialComposer.top)).toBeLessThanOrEqual(2);
    }
    expect(scrolledComposer.bottomGap).toBeLessThanOrEqual(1);

    const collapsedComposer = await page.locator(".composer").evaluate((node) => {
      document.body.classList.add("topbar-collapsed");
      const rect = node.getBoundingClientRect();
      return {
        bottomGap: window.innerHeight - rect.bottom,
        mainHeight: document.querySelector(".codex-main")?.getBoundingClientRect().height || 0,
        topbarHeight: document.querySelector(".topbar")?.getBoundingClientRect().height || 0
      };
    });

    expect(collapsedComposer.bottomGap).toBeLessThanOrEqual(1);
    expect(collapsedComposer.mainHeight).toBeGreaterThan(initialComposer.top + collapsedComposer.topbarHeight / 2);
  } finally {
    clearInterval(keepAlive);
  }
});

test("mobile sidebar toggles and persists dark mode", async ({ page, request }) => {
  await touchMockAgent(request);
  const keepAlive = setInterval(() => {
    touchMockAgent(request).catch(() => {});
  }, 10000);

  try {
    await loginToWorkbench(page);
    await page.locator("#toggleSessionsButton").click();
    await expect(page.locator("#themeModeToggle")).toBeVisible();
    await expect(page.locator("#themeModeToggle")).not.toBeChecked();

    await page.locator(".theme-switch").click();

    await expect(page.locator("#themeModeToggle")).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("body")).toHaveClass(/theme-dark/);
    await expect(page.locator("#themeColorMeta")).toHaveAttribute("content", "#0d1014");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("echoTheme"))).toBe("dark");

    await page.reload();
    await expect(page.locator("#codexView")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("body")).toHaveClass(/theme-dark/);
    await expect(page.locator("#themeModeToggle")).toBeChecked();
  } finally {
    clearInterval(keepAlive);
  }
});

test("mobile quick deploy sends the fixed deployment prompt", async ({ page, request }) => {
  await touchMockAgent(request);
  const headers = await authHeadersForSessionRequests(request);
  const suffix = Date.now();
  const prompt = `一键部署当前对话 ${suffix}`;

  const createResponse = await request.post("/api/codex/sessions", {
    headers,
    data: {
      projectId: "echo",
      prompt,
      runtime: {}
    }
  });
  expect(createResponse.ok()).toBeTruthy();
  const created = await createResponse.json();
  await activateCodexSession(request, created.session.id);

  const keepAlive = setInterval(() => {
    touchMockAgent(request).catch(() => {});
  }, 10000);

  try {
    await loginToWorkbench(page);
    await page.locator("#toggleSessionsButton").click();
    await page.locator(".conversation-item", { hasText: prompt }).locator(".conversation-item-open").click();

    await expect(page.locator("#quickDeployButton")).toBeEnabled();
    await page.locator("#codexPrompt").fill("还没发送的草稿");
    await expect(page.locator("#quickDeployButton")).toBeDisabled();
    await page.locator("#codexPrompt").fill("");
    await expect(page.locator("#quickDeployButton")).toBeEnabled();

    await page.locator("#quickDeployButton").click();

    await expect(page.locator("#codexRunSummary")).toContainText("请把当前对话中已经完成且适合发布的代码改动提交、推送");
    await expect(page.locator(".toast", { hasText: "已发送部署指令" })).toHaveCount(0);
    await expect(page.locator("#quickDeployButton")).toBeDisabled();

    const sessionResponse = await request.get(`/api/codex/sessions/${created.session.id}`, { headers });
    expect(sessionResponse.ok()).toBeTruthy();
    const sessionData = await sessionResponse.json();
    expect(
      sessionData.session.messages.some(
        (message) => message.role === "user" && String(message.text || "").includes("不要强行运行与项目技术栈无关的检查")
      )
    ).toBeTruthy();
  } finally {
    clearInterval(keepAlive);
  }
});

test("mobile codex polling keeps the conversation viewport stable", async ({ page, request }) => {
  await touchMockAgent(request);
  const keepAlive = setInterval(() => {
    touchMockAgent(request).catch(() => {});
  }, 10000);

  try {
    const headers = await authHeadersForSessionRequests(request);
    const suffix = Date.now();
    const longPrompt = [
      `轮询不应该推动对话 ${suffix}`,
      ...Array.from({ length: 100 }, (_, index) => `稳定滚动行 ${index + 1}`)
    ].join("\n");

    const response = await request.post("/api/codex/sessions", {
      headers,
      data: {
        projectId: "echo",
        prompt: longPrompt,
        runtime: {}
      }
    });
    expect(response.ok()).toBeTruthy();

    await loginToWorkbench(page);
    await expect(page.locator("#codexRunSummary")).toContainText(`轮询不应该推动对话 ${suffix}`);
    await page.waitForTimeout(120);

    const before = await page.locator("#codexJobDetail").evaluate(async (node) => {
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll"));
      await nextFrame();
      node.scrollTop = 160;
      node.dispatchEvent(new Event("scroll"));
      await nextFrame();
      return {
        scrollTop: Math.round(node.scrollTop),
        distanceToBottom: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop)
      };
    });
    expect(before.scrollTop).toBeGreaterThan(0);
    expect(before.distanceToBottom).toBeGreaterThan(32);
    await expect(page.locator("body")).toHaveClass(/topbar-collapsed/);

    await page.waitForTimeout(3900);

    await expect(page.locator("body")).toHaveClass(/topbar-collapsed/);
    const after = await page.locator("#codexJobDetail").evaluate((node) => Math.round(node.scrollTop));
    expect(Math.abs(after - before.scrollTop)).toBeLessThanOrEqual(2);
  } finally {
    clearInterval(keepAlive);
  }
});

test("mobile opens a historical conversation at the latest message", async ({ page, request }) => {
  await touchMockAgent(request);
  const keepAlive = setInterval(() => {
    touchMockAgent(request).catch(() => {});
  }, 10000);

  try {
    const headers = await authHeadersForSessionRequests(request);
    const suffix = Date.now();
    const historicalPrompt = [
      `历史长对话自动滚动 ${suffix}`,
      ...Array.from({ length: 90 }, (_, index) => `历史消息行 ${index + 1}`)
    ].join("\n");
    const recentPrompt = `最近短对话 ${suffix}`;

    const historicalResponse = await request.post("/api/codex/sessions", {
      headers,
      data: {
        projectId: "echo",
        prompt: historicalPrompt,
        runtime: {}
      }
    });
    expect(historicalResponse.ok()).toBeTruthy();

    const recentResponse = await request.post("/api/codex/sessions", {
      headers,
      data: {
        projectId: "echo",
        prompt: recentPrompt,
        runtime: {}
      }
    });
    expect(recentResponse.ok()).toBeTruthy();

    await loginToWorkbench(page);
    await page.locator("#toggleSessionsButton").click();
    await page
      .locator(".conversation-item", { hasText: `历史长对话自动滚动 ${suffix}` })
      .locator(".conversation-item-open")
      .click();

    await expect(page.locator("#codexRunSummary")).toContainText(`历史长对话自动滚动 ${suffix}`);
    await expect
      .poll(() =>
        page.locator("#codexJobDetail").evaluate((node) => {
          return Math.round(node.scrollHeight - node.clientHeight - node.scrollTop);
        })
      )
      .toBeLessThanOrEqual(2);
  } finally {
    clearInterval(keepAlive);
  }
});
