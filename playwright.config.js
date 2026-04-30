import { defineConfig } from "@playwright/test";

const port = 4011;
const host = "127.0.0.1";
const baseUrl = `http://${host}:${port}`;
const workspacePath = process.cwd();

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: baseUrl,
    browserName: "chromium",
    headless: true,
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    colorScheme: "light"
  },
  webServer: {
    command:
      `mkdir -p .tmp/mobile-e2e-home && ` +
      `HOME="${workspacePath}/.tmp/mobile-e2e-home" ` +
      `ECHO_MODE=relay ` +
      `ECHO_HOST=${host} ` +
      `ECHO_PORT=${port} ` +
      `ECHO_PUBLIC_URL=${baseUrl} ` +
      `ECHO_TOKEN=e2e-pairing-token-123456 ` +
      `ECHO_AUTH_ENABLED=true ` +
      `ECHO_USERS_JSON= ` +
      `ECHO_AUTH_USERNAME=mobile_e2e_user_20260430 ` +
      `ECHO_AUTH_PASSWORD=MobileE2EPass20260430 ` +
      `ECHO_AUTH_PASSWORD_SHA256= ` +
      `ECHO_AUTH_DISPLAY_NAME=Mobile-E2E ` +
      `ECHO_SESSION_SECRET=e2e-session-secret ` +
      `ECHO_CODEX_WORKSPACES=echo=${workspacePath} ` +
      `node src/server.js`,
    url: `${baseUrl}/api/auth/config`,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120000
  }
});
