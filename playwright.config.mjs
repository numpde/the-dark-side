import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: "http://127.0.0.1:8765",
    trace: "on-first-retry",
  },
  webServer: {
    command: "python3 -m http.server 8765 --directory web",
    url: "http://127.0.0.1:8765/",
    reuseExistingServer: true,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  },
});
