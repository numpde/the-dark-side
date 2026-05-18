import { defineConfig } from "@playwright/test";

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: "http://127.0.0.1:8765",
    launchOptions: {
      ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
      args: ["--no-sandbox"],
    },
    trace: "on-first-retry",
  },
  webServer: {
    command: "DARK_SIDE_PREVIEW_HOST=127.0.0.1 DARK_SIDE_PREVIEW_PORT=8765 bash scripts/dev-command.sh preview:web",
    url: "http://127.0.0.1:8765/",
    reuseExistingServer: true,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  },
});
