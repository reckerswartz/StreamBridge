import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 45_000,
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "npm run fixtures:serve",
    url: "http://127.0.0.1:8765/fixture",
    reuseExistingServer: !process.env.CI,
    timeout: 15_000
  }
});
