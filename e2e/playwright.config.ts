import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./journeys",
  fullyParallel: false, // Extensions need persistent context
  workers: 1,
  timeout: 120_000, // 2 min per test (extraction pipeline takes time)
  retries: 0,
  reporter: "html",
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: {
    baseURL: "http://localhost:4000",
    trace: "on-first-retry",
  },
});
